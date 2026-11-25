"""CurtainCall Backend API (FastAPI + MongoDB Atlas + TMDB)."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import ssl
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import certifi
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError
from pymongo.server_api import ServerApi

# =========================================
# Config & Logging
# =========================================

_ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

logger = logging.getLogger("curtaincall")

TMDB_API_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p"
PRIORITY_CREW_JOBS = {
    "Director",
    "Director of Photography",
    "Original Music Composer",
    "Music",
    "Costume Design",
    "Costume Designer",
    "Makeup Artist",
    "Makeup Department Head",
    "Special Effects",
    "Special Effects Supervisor",
    "Visual Effects Supervisor",
    "Production Design",
    "Editor",
    "Sound Designer",
    "Screenplay",
    "Writer",
}


# =========================================
# Password Security (stdlib scrypt)
# =========================================


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, salt_hex, expected_hex = stored_hash.split("$")
        if algo != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(expected_hex)
    except (ValueError, TypeError):
        return False
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=len(expected))
    return hmac.compare_digest(derived, expected)


# =========================================
# MongoDB Atlas Connection
# =========================================

_mongo_client: Optional[MongoClient] = None


def get_mongo_client() -> MongoClient:
    global _mongo_client
    if _mongo_client is None:
        uri = os.getenv("MONGODB_URI", "").strip()
        if not uri:
            raise RuntimeError("MONGODB_URI is not set in backend/.env.")
        _mongo_client = MongoClient(
            uri,
            server_api=ServerApi("1"),
            tlsCAFile=certifi.where(),
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
        )
    return _mongo_client


def get_db():
    return get_mongo_client()[os.getenv("MONGODB_DB_NAME", "curtaincall").strip() or "curtaincall"]


def users_col():
    return get_db()["users"]


def reviews_col():
    return get_db()["reviews"]


def ping_database() -> dict:
    get_mongo_client().admin.command("ping")
    db = get_db()
    return {
        "connected": True,
        "database": db.name,
        "collections": sorted(db.list_collection_names()),
    }


def ensure_indexes() -> None:
    users_col().create_index([("email", ASCENDING)], unique=True, name="idx_users_email_unique")
    users_col().create_index([("username", ASCENDING)], unique=True, name="idx_users_username_unique")
    reviews_col().create_index([("user_id", ASCENDING), ("created_at", DESCENDING)], name="idx_reviews_user_created")
    reviews_col().create_index([("movie_id", ASCENDING), ("created_at", DESCENDING)], name="idx_reviews_movie_created")


def close_mongo_client() -> None:
    global _mongo_client
    if _mongo_client is not None:
        _mongo_client.close()
        _mongo_client = None


# =========================================
# TMDB API Client
# =========================================


def is_tmdb_configured() -> bool:
    load_dotenv(dotenv_path=_ENV_PATH, override=False)
    return bool(os.getenv("TMDB_READ_ACCESS_TOKEN", "").strip() or os.getenv("TMDB_API_KEY", "").strip())


def _tmdb_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    load_dotenv(dotenv_path=_ENV_PATH, override=False)
    token = os.getenv("TMDB_READ_ACCESS_TOKEN", "").strip()
    api_key = os.getenv("TMDB_API_KEY", "").strip()
    if not token and not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TMDB credentials are not configured. Set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in backend/.env.",
        )

    query = dict(params or {})
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        query["api_key"] = api_key

    url = f"{TMDB_API_BASE}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    req = urllib.request.Request(url, headers=headers, method="GET")
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())

    try:
        with urllib.request.urlopen(req, timeout=8, context=ssl_ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = f"TMDB returned HTTP {exc.code}."
        try:
            body = json.loads(exc.read().decode("utf-8"))
            if body.get("status_message"):
                detail = f"TMDB error: {body['status_message']}"
        except Exception:
            pass
        raise HTTPException(status_code=exc.code if 400 <= exc.code < 600 else 502, detail=detail) from exc
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Unable to reach TMDB API: {exc.reason}") from exc


_genre_cache: Optional[Dict[int, str]] = None


def get_tmdb_genre_map() -> Dict[int, str]:
    """Fetch and cache TMDB movie genre ID -> genre name mapping."""
    global _genre_cache
    if _genre_cache is None:
        data = _tmdb_get("/genre/movie/list", {"language": "en-US"})
        _genre_cache = {int(g["id"]): g["name"] for g in data.get("genres", []) if g.get("id") and g.get("name")}
    return _genre_cache


def resolve_tmdb_person_id(name: str) -> Optional[int]:
    """Look up a crew member's TMDB person ID by name."""
    cleaned = name.strip()
    if not cleaned:
        return None
    try:
        data = _tmdb_get("/search/person", {"query": cleaned, "include_adult": "false", "language": "en-US", "page": 1})
        results = data.get("results") or []
        if results and results[0].get("id"):
            return int(results[0]["id"])
    except HTTPException:
        return None
    return None


def _tmdb_image(path: Optional[str], size: str = "w342") -> Optional[str]:
    return f"{TMDB_IMAGE_BASE}/{size}{path}" if path else None


def _parse_year(release_date: Optional[str]) -> Optional[int]:
    if not release_date or len(release_date) < 4:
        return None
    try:
        return int(release_date[:4])
    except ValueError:
        return None


# =========================================
# Pydantic Models
# =========================================


class UserRegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(..., min_length=8, max_length=128)
    email: EmailStr
    first_name: str = Field(..., min_length=1, max_length=64)
    last_name: str = Field(..., min_length=1, max_length=64)
    birthday: date
    avatar_url: Optional[str] = Field(default=None, max_length=250000)
    favorite_genres: List[str] = Field(default_factory=list)
    disliked_genres: List[str] = Field(default_factory=list)
    favorite_crew: List[str] = Field(default_factory=list)
    favorite_crew_ids: List[int] = Field(default_factory=list)
    favorite_departments: List[str] = Field(default_factory=list)


class UserLoginRequest(BaseModel):
    identifier: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class UserUpdateRequest(BaseModel):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    birthday: Optional[date] = None
    avatar_url: Optional[str] = Field(default=None, max_length=250000)
    favorite_genres: Optional[List[str]] = None
    disliked_genres: Optional[List[str]] = None
    favorite_crew: Optional[List[str]] = None
    favorite_crew_ids: Optional[List[int]] = None
    favorite_departments: Optional[List[str]] = None


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    first_name: str
    last_name: str
    birthday: date
    avatar_url: Optional[str] = None
    favorite_genres: List[str]
    disliked_genres: List[str] = Field(default_factory=list)
    favorite_crew: List[str]
    favorite_crew_ids: List[int] = Field(default_factory=list)
    dismissed_movie_ids: List[str] = Field(default_factory=list)
    favorite_departments: List[str]
    created_at: datetime
    updated_at: datetime


class UserStatsResponse(BaseModel):
    user_id: str
    movies_reviewed: int
    average_rating: Optional[float] = None
    favorite_genres: List[str]
    disliked_genres: List[str] = Field(default_factory=list)
    favorite_crew: List[str]
    favorite_departments: List[str]


class DismissMovieRequest(BaseModel):
    movie_id: str = Field(..., min_length=1, max_length=128)


class MovieSearchResult(BaseModel):
    tmdb_id: str
    title: str
    release_year: Optional[int] = None
    overview: str = ""
    poster_url: Optional[str] = None
    backdrop_url: Optional[str] = None
    vote_average: Optional[float] = None


class MovieCrewMember(BaseModel):
    id: int
    name: str
    job: str
    department: str = ""


class MovieDetailResponse(MovieSearchResult):
    runtime: Optional[int] = None
    genres: List[str] = Field(default_factory=list)
    crew: List[MovieCrewMember] = Field(default_factory=list)


class RecommendationItem(MovieSearchResult):
    genres: List[str] = Field(default_factory=list)
    score: int
    matched_crew: List[str] = Field(default_factory=list)
    reason: str


class ReviewCreateRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    movie_id: str = Field(..., min_length=1, max_length=128)
    movie_title: str = Field(..., min_length=1, max_length=200)
    release_year: Optional[int] = Field(default=None, ge=1888, le=2100)
    poster_url: Optional[str] = Field(default=None, max_length=1000)
    genres: List[str] = Field(default_factory=list)
    rating: float = Field(..., ge=0.0, le=10.0)
    liked_departments: List[str] = Field(default_factory=list)
    liked_crew: List[str] = Field(default_factory=list)
    liked_crew_ids: List[int] = Field(default_factory=list)
    comment: str = Field(default="", max_length=4000)


class ReviewUpdateRequest(BaseModel):
    rating: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    liked_departments: Optional[List[str]] = None
    liked_crew: Optional[List[str]] = None
    liked_crew_ids: Optional[List[int]] = None
    comment: Optional[str] = Field(default=None, max_length=4000)


class ReviewResponse(BaseModel):
    id: str
    user_id: str
    username: str
    movie_id: str
    movie_title: str
    release_year: Optional[int] = None
    poster_url: Optional[str] = None
    genres: List[str] = Field(default_factory=list)
    rating: float
    liked_departments: List[str]
    liked_crew: List[str] = Field(default_factory=list)
    liked_crew_ids: List[int] = Field(default_factory=list)
    comment: str
    created_at: datetime
    updated_at: datetime


# =========================================
# Serialization & Helpers
# =========================================


def _parse_oid(raw_id: str, label: str = "ID") -> ObjectId:
    try:
        return ObjectId(raw_id)
    except InvalidId as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {label} format.") from exc


def _serialize_user(doc: dict) -> UserResponse:
    return UserResponse(
        id=str(doc["_id"]),
        username=doc["username"],
        email=doc["email"],
        first_name=doc["first_name"],
        last_name=doc["last_name"],
        birthday=doc["birthday"],
        avatar_url=doc.get("avatar_url"),
        favorite_genres=doc.get("favorite_genres", []),
        disliked_genres=doc.get("disliked_genres", []),
        favorite_crew=doc.get("favorite_crew", []),
        favorite_crew_ids=doc.get("favorite_crew_ids", []),
        dismissed_movie_ids=doc.get("dismissed_movie_ids", []),
        favorite_departments=doc.get("favorite_departments", []),
        created_at=doc["created_at"],
        updated_at=doc["updated_at"],
    )


def _serialize_review(doc: dict) -> ReviewResponse:
    return ReviewResponse(
        id=str(doc["_id"]),
        user_id=doc["user_id"],
        username=doc["username"],
        movie_id=doc["movie_id"],
        movie_title=doc["movie_title"],
        release_year=doc.get("release_year"),
        poster_url=doc.get("poster_url"),
        genres=doc.get("genres", []),
        rating=doc["rating"],
        liked_departments=doc.get("liked_departments", []),
        liked_crew=doc.get("liked_crew", []),
        liked_crew_ids=doc.get("liked_crew_ids", []),
        comment=doc.get("comment", ""),
        created_at=doc["created_at"],
        updated_at=doc["updated_at"],
    )


# =========================================
# FastAPI
# =========================================


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        ping_database()
        ensure_indexes()
        logger.info("Connected to MongoDB Atlas and verified indexes.")
    except Exception as exc:
        logger.warning("MongoDB Atlas unavailable at startup (%s). Will retry on request.", exc)
    yield
    close_mongo_client()


app = FastAPI(title="CurtainCall API", version="0.2.0", lifespan=lifespan)

_cors_origins = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[*_cors_origins, "null"],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(PyMongoError)
def pymongo_exception_handler(_request: Request, exc: PyMongoError):
    logger.error("MongoDB Atlas error: %s", exc)
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "detail": (
                "Cannot connect to MongoDB Atlas right now. "
                "Verify your network allows port 27017 (or switch to a hotspot) and check Atlas Network Access."
            )
        },
    )


# =========================================
# Routes: Health
# =========================================


@app.get("/api/health", tags=["Health"])
def health_check():
    return {"status": "ok", "tmdb_configured": is_tmdb_configured(), **ping_database()}


# =========================================
# Routes: Movies (TMDB)
# =========================================


@app.get("/api/movies/search", response_model=List[MovieSearchResult], tags=["Movies"])
def api_search_movies(q: str = Query(..., min_length=1, max_length=120)):
    data = _tmdb_get("/search/movie", {"query": q.strip(), "include_adult": "false", "language": "en-US", "page": 1})
    return [
        {
            "tmdb_id": str(item["id"]),
            "title": item.get("title") or item.get("original_title") or "Untitled",
            "release_year": _parse_year(item.get("release_date")),
            "overview": item.get("overview") or "",
            "poster_url": _tmdb_image(item.get("poster_path"), "w342"),
            "backdrop_url": _tmdb_image(item.get("backdrop_path"), "w780"),
            "vote_average": round(float(item["vote_average"]), 1) if item.get("vote_average") is not None else None,
        }
        for item in data.get("results", [])[:12]
    ]


@app.get("/api/movies/{tmdb_id}", response_model=MovieDetailResponse, tags=["Movies"])
def api_get_movie_details(tmdb_id: str):
    data = _tmdb_get(f"/movie/{urllib.parse.quote(tmdb_id.strip())}", {"append_to_response": "credits", "language": "en-US"})
    crew_raw = (data.get("credits") or {}).get("crew") or []
    seen, crew = set(), []
    for pass_priority in (True, False):
        limit = 12 if pass_priority else 8
        if not pass_priority and len(crew) >= 6:
            break
        for m in crew_raw:
            pid = m.get("id")
            name, job, dept = (m.get("name") or "").strip(), (m.get("job") or "").strip(), (m.get("department") or "").strip()
            if not pid or not name or (pass_priority and job not in PRIORITY_CREW_JOBS) or (name, job) in seen:
                continue
            seen.add((name, job))
            crew.append({"id": int(pid), "name": name, "job": job, "department": dept})
            if len(crew) >= limit:
                break

    return {
        "tmdb_id": str(data["id"]),
        "title": data.get("title") or data.get("original_title") or "Untitled",
        "release_year": _parse_year(data.get("release_date")),
        "runtime": data.get("runtime"),
        "overview": data.get("overview") or "",
        "poster_url": _tmdb_image(data.get("poster_path"), "w342"),
        "backdrop_url": _tmdb_image(data.get("backdrop_path"), "w780"),
        "vote_average": round(float(data["vote_average"]), 1) if data.get("vote_average") is not None else None,
        "genres": [g["name"] for g in data.get("genres", []) if g.get("name")],
        "crew": crew,
    }


# =========================================
# Routes: Users
# =========================================


@app.post("/api/users/register", response_model=UserResponse, status_code=201, tags=["Users"])
def register_user(payload: UserRegisterRequest):
    now = datetime.now(timezone.utc)
    doc = {
        "username": payload.username.strip(),
        "email": payload.email.strip().lower(),
        "password_hash": hash_password(payload.password),
        "first_name": payload.first_name.strip(),
        "last_name": payload.last_name.strip(),
        "birthday": payload.birthday.isoformat(),
        "avatar_url": payload.avatar_url,
        "favorite_genres": payload.favorite_genres,
        "disliked_genres": payload.disliked_genres,
        "favorite_crew": payload.favorite_crew,
        "favorite_crew_ids": payload.favorite_crew_ids,
        "dismissed_movie_ids": [],
        "favorite_departments": payload.favorite_departments,
        "created_at": now,
        "updated_at": now,
    }
    try:
        result = users_col().insert_one(doc)
    except DuplicateKeyError as exc:
        raise HTTPException(status_code=409, detail="A user with that username or email already exists.") from exc
    doc["_id"] = result.inserted_id
    return _serialize_user(doc)


@app.post("/api/users/login", response_model=UserResponse, tags=["Users"])
def login_user(payload: UserLoginRequest):
    identifier = payload.identifier.strip()
    user_doc = users_col().find_one({"$or": [{"email": identifier.lower()}, {"username": identifier}]})
    if not user_doc or not verify_password(payload.password, user_doc.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid username/email or password.")
    return _serialize_user(user_doc)


@app.get("/api/users", response_model=List[UserResponse], tags=["Users"])
def list_users(limit: int = Query(default=50, ge=1, le=200)):
    return [_serialize_user(doc) for doc in users_col().find({}).sort("created_at", DESCENDING).limit(limit)]


@app.get("/api/users/{user_id}", response_model=UserResponse, tags=["Users"])
def get_user(user_id: str):
    user_doc = users_col().find_one({"_id": _parse_oid(user_id, "user_id")})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found.")
    return _serialize_user(user_doc)


@app.get("/api/users/{user_id}/stats", response_model=UserStatsResponse, tags=["Users"])
def get_user_stats(user_id: str):
    oid = _parse_oid(user_id, "user_id")
    user_doc = users_col().find_one({"_id": oid})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found.")
    user_reviews = list(reviews_col().find({"user_id": str(oid)}))
    count = len(user_reviews)
    avg = round(sum(r["rating"] for r in user_reviews) / count, 1) if count > 0 else None
    return UserStatsResponse(
        user_id=str(oid),
        movies_reviewed=count,
        average_rating=avg,
        favorite_genres=user_doc.get("favorite_genres", []),
        disliked_genres=user_doc.get("disliked_genres", []),
        favorite_crew=user_doc.get("favorite_crew", []),
        favorite_departments=user_doc.get("favorite_departments", []),
    )


@app.post("/api/users/{user_id}/dismiss", response_model=UserResponse, tags=["Users"])
def dismiss_movie(user_id: str, payload: DismissMovieRequest):
    """Record a movie ID as dismissed so it is filtered out of future recommendations."""
    oid = _parse_oid(user_id, "user_id")
    updated = users_col().find_one_and_update(
        {"_id": oid},
        {
            "$addToSet": {"dismissed_movie_ids": payload.movie_id.strip()},
            "$set": {"updated_at": datetime.now(timezone.utc)},
        },
        return_document=True,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="User not found.")
    return _serialize_user(updated)


@app.get("/api/users/{user_id}/recommendations", response_model=List[RecommendationItem], tags=["Users"])
def get_user_recommendations(user_id: str, limit: int = Query(default=10, ge=1, le=20)):
    """Generate scored movie recommendations using TMDB /discover/movie?with_crew and user reviews."""
    oid = _parse_oid(user_id, "user_id")
    user_doc = users_col().find_one({"_id": oid})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found.")

    user_reviews = list(reviews_col().find({"user_id": str(oid)}))
    seen_ids = {str(r["movie_id"]) for r in user_reviews if r.get("movie_id")}
    dismissed_ids = {str(m) for m in user_doc.get("dismissed_movie_ids", [])}
    excluded_ids = seen_ids | dismissed_ids

    # Build crew map (crew_id -> crew_name) from profile + reviews, resolving any legacy names via TMDB.
    crew_id_to_name: Dict[int, str] = {}
    profile_crew_ids: List[int] = [int(cid) for cid in user_doc.get("favorite_crew_ids", []) if str(cid).isdigit()]
    profile_crew_names: List[str] = [n.strip() for n in user_doc.get("favorite_crew", []) if n and n.strip()]

    for cid in profile_crew_ids:
        crew_id_to_name[cid] = f"Crew #{cid}"

    for rev in user_reviews:
        r_ids = rev.get("liked_crew_ids") or []
        r_names = rev.get("liked_crew") or []
        for idx, cid in enumerate(r_ids):
            try:
                cid_int = int(cid)
            except (TypeError, ValueError):
                continue
            name = r_names[idx] if idx < len(r_names) else crew_id_to_name.get(cid_int, f"Crew #{cid_int}")
            crew_id_to_name[cid_int] = name

    # Resolve any profile favorite_crew names that don't yet have cached TMDB person IDs.
    newly_resolved_ids: List[int] = []
    if profile_crew_names and len(crew_id_to_name) < len(profile_crew_names):
        existing_names_lower = {n.lower() for n in crew_id_to_name.values()}
        for name in profile_crew_names[:10]:
            if name.lower() in existing_names_lower:
                continue
            pid = resolve_tmdb_person_id(name)
            if pid:
                crew_id_to_name[pid] = name
                if pid not in profile_crew_ids:
                    newly_resolved_ids.append(pid)
        if newly_resolved_ids:
            users_col().update_one(
                {"_id": oid},
                {"$addToSet": {"favorite_crew_ids": {"$each": newly_resolved_ids}}},
            )

    genre_map = get_tmdb_genre_map()

    # Collect candidate movies from TMDB /discover/movie?with_crew=<id>
    # Querying per crew ID lets us count exact liked crew matches (+5 each) per movie!
    candidates: Dict[str, Dict[str, Any]] = {}
    for cid, cname in list(crew_id_to_name.items())[:8]:
        data = _tmdb_get(
            "/discover/movie",
            {
                "with_crew": str(cid),
                "include_adult": "false",
                "language": "en-US",
                "sort_by": "popularity.desc",
                "page": 1,
            },
        )
        for item in data.get("results", [])[:15]:
            mid = str(item["id"])
            if mid in excluded_ids:
                continue
            if mid not in candidates:
                candidates[mid] = {"raw": item, "matched_crew": []}
            if cname not in candidates[mid]["matched_crew"]:
                candidates[mid]["matched_crew"].append(cname)

    # Fallback if user has no crew IDs yet: discover by positively reviewed or favorite genres.
    if not candidates:
        name_to_gid = {v.lower(): str(k) for k, v in genre_map.items()}
        seed_genre_names = list(user_doc.get("favorite_genres", []))
        for rev in user_reviews:
            if float(rev.get("rating", 0)) >= 6.0:
                seed_genre_names.extend(rev.get("genres") or [])
        seed_gids = [name_to_gid[g.lower()] for g in dict.fromkeys(seed_genre_names) if g.lower() in name_to_gid]
        discover_params: Dict[str, Any] = {
            "include_adult": "false",
            "language": "en-US",
            "sort_by": "popularity.desc",
            "vote_count.gte": 100,
            "page": 1,
        }
        if seed_gids:
            discover_params["with_genres"] = "|".join(seed_gids[:4])
        data = _tmdb_get("/discover/movie", discover_params)
        for item in data.get("results", [])[:20]:
            mid = str(item["id"])
            if mid not in excluded_ids:
                candidates[mid] = {"raw": item, "matched_crew": []}

    # Precompute genre sets from user's positive reviews (>= 6.0), disliked reviews (< 5.0), and disliked_genres.
    positive_review_genres: List[set[str]] = []
    disliked_review_genres: List[set[str]] = []
    for rev in user_reviews:
        r_genres = {g.strip().lower() for g in (rev.get("genres") or []) if g and g.strip()}
        if not r_genres:
            continue
        rating = float(rev.get("rating", 0))
        if rating >= 6.0:
            positive_review_genres.append(r_genres)
        elif rating < 5.0:
            disliked_review_genres.append(r_genres)

    disliked_genre_set = {g.strip().lower() for g in user_doc.get("disliked_genres", []) if g and g.strip()}

    scored: List[Dict[str, Any]] = []
    for mid, entry in candidates.items():
        item = entry["raw"]
        matched_crew: List[str] = entry["matched_crew"]
        movie_genres = [genre_map[int(gid)] for gid in (item.get("genre_ids") or []) if int(gid) in genre_map]
        movie_genres_lower = {g.lower() for g in movie_genres}
        vote_avg = round(float(item["vote_average"]), 1) if item.get("vote_average") is not None else None

        score = 0
        reasons: List[str] = []

        # +5 for each liked crew member credited
        if matched_crew:
            score += 5 * len(matched_crew)
            reasons.append(f"Features liked crew: {', '.join(matched_crew[:3])}")

        # +1 for each positively reviewed movie in the same genre; -1 for each disliked movie in the same genre
        pos_matches = sum(1 for gset in positive_review_genres if gset & movie_genres_lower)
        neg_matches = sum(1 for gset in disliked_review_genres if gset & movie_genres_lower)
        score += pos_matches
        score -= neg_matches
        if pos_matches > 0:
            reasons.append(f"Matches {pos_matches} movie{'s' if pos_matches != 1 else ''} you rated positively in this genre")

        # +10 for movies with a 7.5+ rating
        if vote_avg is not None and vote_avg >= 7.5:
            score += 10
            reasons.append(f"Critically acclaimed ({vote_avg} on TMDB)")

        # -15 if movie is in a disliked genre
        if movie_genres_lower & disliked_genre_set:
            score -= 15

        if not reasons:
            reasons.append(
                f"Popular in {', '.join(movie_genres[:2])}" if movie_genres else "Recommended for your Curtain Call watchlist"
            )

        scored.append(
            {
                "tmdb_id": mid,
                "title": item.get("title") or item.get("original_title") or "Untitled",
                "release_year": _parse_year(item.get("release_date")),
                "overview": item.get("overview") or "",
                "poster_url": _tmdb_image(item.get("poster_path"), "w342"),
                "backdrop_url": _tmdb_image(item.get("backdrop_path"), "w780"),
                "vote_average": vote_avg,
                "genres": movie_genres,
                "score": score,
                "matched_crew": matched_crew,
                "reason": " • ".join(reasons) + ".",
                "_popularity": float(item.get("popularity") or 0.0),
            }
        )

    scored.sort(key=lambda m: (m["score"], m["vote_average"] or 0.0, m["_popularity"]), reverse=True)
    for m in scored:
        m.pop("_popularity", None)
    return scored[:limit]


@app.patch("/api/users/{user_id}", response_model=UserResponse, tags=["Users"])
def update_user(user_id: str, payload: UserUpdateRequest):
    oid = _parse_oid(user_id, "user_id")
    updates = {}
    for key, value in payload.model_dump(exclude_unset=True).items():
        if key == "avatar_url":
            updates[key] = value or None
        elif value is not None:
            updates[key] = value
    if not updates:
        raise HTTPException(status_code=400, detail="No fields provided to update.")
    if "first_name" in updates:
        updates["first_name"] = updates["first_name"].strip()
    if "last_name" in updates:
        updates["last_name"] = updates["last_name"].strip()
    if "birthday" in updates:
        updates["birthday"] = updates["birthday"].isoformat()
    updates["updated_at"] = datetime.now(timezone.utc)

    updated = users_col().find_one_and_update({"_id": oid}, {"$set": updates}, return_document=True)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found.")
    return _serialize_user(updated)


# =========================================
# Routes: Reviews
# =========================================


@app.post("/api/reviews", response_model=ReviewResponse, status_code=201, tags=["Reviews"])
def create_review(payload: ReviewCreateRequest):
    user_oid = _parse_oid(payload.user_id, "user_id")
    user_doc = users_col().find_one({"_id": user_oid})
    if not user_doc:
        raise HTTPException(status_code=404, detail="Referenced user does not exist.")
    now = datetime.now(timezone.utc)
    doc = {
        "user_id": str(user_oid),
        "username": user_doc["username"],
        "movie_id": payload.movie_id.strip(),
        "movie_title": payload.movie_title.strip(),
        "release_year": payload.release_year,
        "poster_url": payload.poster_url,
        "genres": payload.genres,
        "rating": payload.rating,
        "liked_departments": payload.liked_departments,
        "liked_crew": payload.liked_crew,
        "liked_crew_ids": payload.liked_crew_ids,
        "comment": payload.comment.strip(),
        "created_at": now,
        "updated_at": now,
    }
    result = reviews_col().insert_one(doc)
    doc["_id"] = result.inserted_id

    # Automatically add liked crew IDs/names and departments to the user's profile.
    profile_add: Dict[str, Any] = {}
    if payload.liked_crew_ids:
        profile_add["favorite_crew_ids"] = {"$each": [int(cid) for cid in payload.liked_crew_ids]}
    if payload.liked_crew:
        profile_add["favorite_crew"] = {"$each": [c.strip() for c in payload.liked_crew if c.strip()]}
    if payload.liked_departments:
        profile_add["favorite_departments"] = {"$each": [d.strip() for d in payload.liked_departments if d.strip()]}
    if profile_add:
        users_col().update_one(
            {"_id": user_oid},
            {"$addToSet": profile_add, "$set": {"updated_at": now}},
        )

    return _serialize_review(doc)


@app.get("/api/reviews", response_model=List[ReviewResponse], tags=["Reviews"])
def list_reviews(
    user_id: Optional[str] = Query(default=None),
    movie_id: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    query: dict = {}
    if user_id:
        _parse_oid(user_id, "user_id")
        query["user_id"] = user_id
    if movie_id:
        query["movie_id"] = movie_id.strip()
    return [_serialize_review(doc) for doc in reviews_col().find(query).sort("created_at", DESCENDING).limit(limit)]


@app.get("/api/reviews/{review_id}", response_model=ReviewResponse, tags=["Reviews"])
def get_review(review_id: str):
    doc = reviews_col().find_one({"_id": _parse_oid(review_id, "review_id")})
    if not doc:
        raise HTTPException(status_code=404, detail="Review not found.")
    return _serialize_review(doc)


@app.patch("/api/reviews/{review_id}", response_model=ReviewResponse, tags=["Reviews"])
def update_review(review_id: str, payload: ReviewUpdateRequest):
    oid = _parse_oid(review_id, "review_id")
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields provided to update.")
    if "comment" in updates:
        updates["comment"] = updates["comment"].strip()
    updates["updated_at"] = datetime.now(timezone.utc)
    updated = reviews_col().find_one_and_update({"_id": oid}, {"$set": updates}, return_document=True)
    if not updated:
        raise HTTPException(status_code=404, detail="Review not found.")
    return _serialize_review(updated)


@app.delete("/api/reviews/{review_id}", status_code=204, tags=["Reviews"])
def delete_review(review_id: str):
    result = reviews_col().delete_one({"_id": _parse_oid(review_id, "review_id")})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Review not found.")
    return None
