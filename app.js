/**
 * CurtainCall Single-Page Application
 * Consolidates API client, SPA router, Sign-In/Create Account, Profile, and Reviews.
 */
(function (global) {
  "use strict";

  // =========================================
  // Config & Utilities
  // =========================================

  const STORAGE_KEY = "curtaincall_user";
  const PRODUCTION_API_URL = "https://curtaincall-api.onrender.com";

  const DEPARTMENTS = [
    "Special Effects",
    "Make Up",
    "Costume Designer",
    "Cinematography",
    "Original Score",
    "Production Design",
    "Sound Design",
    "Directing",
    "Film Editing",
  ];

  function getApiBaseUrl() {
    if (global.CURTAINCALL_API_URL) return global.CURTAINCALL_API_URL.replace(/\/+$/, "");
    return PRODUCTION_API_URL;
  }

  async function apiRequest(path, options = {}) {
    const res = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      headers: Object.assign({ "Content-Type": "application/json" }, options.headers || {}),
    });
    if (res.status === 204) return null;
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const detail =
        data && typeof data === "object" && data.detail
          ? data.detail
          : `Request failed with status ${res.status}`;
      const err = new Error(typeof detail === "string" ? detail : "Validation failed.");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const API = {
    getBaseUrl: getApiBaseUrl,
    checkHealth: () => apiRequest("/api/health"),
    registerUser: (p) => apiRequest("/api/users/register", { method: "POST", body: JSON.stringify(p) }),
    loginUser: (identifier, password) =>
      apiRequest("/api/users/login", { method: "POST", body: JSON.stringify({ identifier, password }) }),
    getUser: (id) => apiRequest(`/api/users/${encodeURIComponent(id)}`),
    getUserStats: (id) => apiRequest(`/api/users/${encodeURIComponent(id)}/stats`),
    getRecommendations: (id, limit = 10) =>
      apiRequest(`/api/users/${encodeURIComponent(id)}/recommendations?limit=${encodeURIComponent(limit)}`),
    dismissMovie: (id, movie_id) =>
      apiRequest(`/api/users/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: JSON.stringify({ movie_id }) }),
    updateUser: (id, p) => apiRequest(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(p) }),
    searchMovies: (q) => apiRequest(`/api/movies/search?q=${encodeURIComponent(q)}`),
    getMovieDetails: (id) => apiRequest(`/api/movies/${encodeURIComponent(id)}`),
    createReview: (p) => apiRequest("/api/reviews", { method: "POST", body: JSON.stringify(p) }),
    listReviews: ({ userId, movieId, limit } = {}) => {
      const qs = new URLSearchParams();
      if (userId) qs.set("user_id", userId);
      if (movieId) qs.set("movie_id", movieId);
      if (limit) qs.set("limit", String(limit));
      const str = qs.toString();
      return apiRequest(`/api/reviews${str ? `?${str}` : ""}`);
    },
    deleteReview: (id) => apiRequest(`/api/reviews/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };

  global.CurtainCallAPI = API;

  function loadUser() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveUser(user) {
    try {
      if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function formatError(err) {
    if (!err) return "Something went wrong. Please try again.";
    if (err.data && Array.isArray(err.data.detail) && err.data.detail.length > 0) {
      const first = err.data.detail[0];
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
      return field ? `${field.replace(/_/g, " ")}: ${first.msg}` : first.msg;
    }
    if (err.message === "Failed to fetch" || err instanceof TypeError) {
      return `Unable to reach the Curtain Call API (${getApiBaseUrl()}). The server may be waking up—please wait a few seconds and try again.`;
    }
    return err.message || "Request failed. Please try again.";
  }

  function showBanner(el, type, text) {
    if (!el) return;
    el.className = `auth-message ${type}`;
    el.innerHTML = "";
    const icon = document.createElement("i");
    icon.className = type === "success" ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation";
    icon.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.textContent = text;
    el.append(icon, span);
    el.hidden = false;
  }

  function hideBanner(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function formatDateOnly(iso) {
    if (!iso) return "—";
    const parts = String(iso).split("T")[0].split("-");
    if (parts.length !== 3) return iso;
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return Number.isNaN(dt.getTime())
      ? iso
      : dt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function formatTimestamp(iso, monthStyle = "long") {
    if (!iso) return "—";
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime())
      ? iso
      : dt.toLocaleDateString(undefined, { year: "numeric", month: monthStyle, day: "numeric" });
  }

  function placeholderPoster(title) {
    return `https://placehold.co/342x513/0a1026/e5b85c?text=${encodeURIComponent(title || "Curtain Call")}`;
  }

  function renderTags(target, items, iconClass, emptyText) {
    target.innerHTML = "";
    if (!items || items.length === 0) {
      const empty = document.createElement("span");
      empty.className = "stat-empty";
      empty.textContent = emptyText;
      target.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const tag = document.createElement("span");
      tag.className = "stat-tag";
      const icon = document.createElement("i");
      icon.className = iconClass;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = item;
      tag.append(icon, label);
      target.appendChild(tag);
    });
  }

  function resizeImageToDataUrl(file, maxSize = 256) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Unable to read the selected image file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Selected file is not a valid image."));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const size = Math.min(maxSize, Math.max(img.width, img.height));
          canvas.width = size;
          canvas.height = size;
          const minSide = Math.min(img.width, img.height);
          canvas
            .getContext("2d")
            .drawImage(img, (img.width - minSide) / 2, (img.height - minSide) / 2, minSide, minSide, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // =========================================
  // View: Sign In & Create Account (#signin / #signup)
  // =========================================

  const AUTH_TEMPLATE = `
    <div class="auth-tabs" role="tablist" aria-label="Account Access">
      <button type="button" id="tab-signin" class="auth-tab active" role="tab" aria-selected="true">
        <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> Sign In
      </button>
      <button type="button" id="tab-signup" class="auth-tab" role="tab" aria-selected="false">
        <i class="fa-solid fa-user-plus" aria-hidden="true"></i> Create Account
      </button>
    </div>

    <div class="section-header">
      <h2 id="auth-heading" class="section-title">Welcome Back</h2>
      <span class="header-divider"></span>
    </div>

    <p id="auth-subtitle" class="auth-subtitle">
      Sign in with your Curtain Call username or email to access your reviews and recommendations.
    </p>

    <div id="auth-message" class="auth-message" role="alert" aria-live="polite" hidden></div>

    <form id="signin-form" class="auth-form" novalidate>
      <div class="form-group">
        <label class="form-label" for="signin-identifier">Username or Email</label>
        <div class="input-wrapper">
          <i class="fa-solid fa-user input-icon" aria-hidden="true"></i>
          <input type="text" id="signin-identifier" class="form-input" placeholder="username or email" autocomplete="username" required>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="signin-password">Password</label>
        <div class="input-wrapper">
          <i class="fa-solid fa-lock input-icon" aria-hidden="true"></i>
          <input type="password" id="signin-password" class="form-input has-toggle" placeholder="Enter your password" autocomplete="current-password" required>
          <button type="button" class="btn-toggle-password" data-target="signin-password" aria-label="Show password">
            <i class="fa-solid fa-eye" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <button type="submit" id="signin-submit" class="btn-primary">
        <span>Sign In</span>
        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
    </form>

    <form id="signup-form" class="auth-form" novalidate hidden>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="signup-first-name">First Name</label>
          <div class="input-wrapper">
            <i class="fa-solid fa-id-card input-icon" aria-hidden="true"></i>
            <input type="text" id="signup-first-name" class="form-input" placeholder="First name" autocomplete="given-name" required>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="signup-last-name">Last Name</label>
          <div class="input-wrapper">
            <i class="fa-solid fa-id-card input-icon" aria-hidden="true"></i>
            <input type="text" id="signup-last-name" class="form-input" placeholder="Last name" autocomplete="family-name" required>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="signup-username">Username</label>
        <div class="input-wrapper">
          <i class="fa-solid fa-at input-icon" aria-hidden="true"></i>
          <input type="text" id="signup-username" class="form-input" placeholder="Choose a username" autocomplete="username" required>
        </div>
        <span class="form-hint">3–32 characters: letters, numbers, dots, underscores, or hyphens.</span>
      </div>

      <div class="form-group">
        <label class="form-label" for="signup-email">Email Address</label>
        <div class="input-wrapper">
          <i class="fa-solid fa-envelope input-icon" aria-hidden="true"></i>
          <input type="email" id="signup-email" class="form-input" placeholder="you@example.com" autocomplete="email" required>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="signup-birthday">Birthday</label>
        <div class="input-wrapper">
          <i class="fa-solid fa-cake-candles input-icon" aria-hidden="true"></i>
          <input type="date" id="signup-birthday" class="form-input" autocomplete="bday" required>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="signup-password">Password</label>
          <div class="input-wrapper">
            <i class="fa-solid fa-lock input-icon" aria-hidden="true"></i>
            <input type="password" id="signup-password" class="form-input has-toggle" placeholder="Min. 8 characters" minlength="8" autocomplete="new-password" required>
            <button type="button" class="btn-toggle-password" data-target="signup-password" aria-label="Show password">
              <i class="fa-solid fa-eye" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="signup-confirm-password">Confirm Password</label>
          <div class="input-wrapper">
            <i class="fa-solid fa-shield-halved input-icon" aria-hidden="true"></i>
            <input type="password" id="signup-confirm-password" class="form-input has-toggle" placeholder="Re-enter password" minlength="8" autocomplete="new-password" required>
            <button type="button" class="btn-toggle-password" data-target="signup-confirm-password" aria-label="Show password">
              <i class="fa-solid fa-eye" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>

      <button type="submit" id="signup-submit" class="btn-primary">
        <span>Create Account</span>
        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
    </form>
  `;

  function mountAuthView(container, initialMode, navigate) {
    container.innerHTML = AUTH_TEMPLATE;
    const $ = (id) => container.querySelector(`#${id}`);
    const tabSignIn = $("tab-signin");
    const tabSignUp = $("tab-signup");
    const heading = $("auth-heading");
    const subtitle = $("auth-subtitle");
    const msg = $("auth-message");
    const signInForm = $("signin-form");
    const signUpForm = $("signup-form");
    const signInSubmit = $("signin-submit");
    const signUpSubmit = $("signup-submit");

    let mode = initialMode === "signup" ? "signup" : "signin";

    function setMode(next) {
      mode = next === "signup" ? "signup" : "signin";
      const isSignIn = mode === "signin";
      hideBanner(msg);
      tabSignIn.classList.toggle("active", isSignIn);
      tabSignIn.setAttribute("aria-selected", String(isSignIn));
      tabSignUp.classList.toggle("active", !isSignIn);
      tabSignUp.setAttribute("aria-selected", String(!isSignIn));
      signInForm.hidden = !isSignIn;
      signUpForm.hidden = isSignIn;
      heading.textContent = isSignIn ? "Welcome Back" : "Create Account";
      subtitle.textContent = isSignIn
        ? "Sign in with your Curtain Call username or email to access your reviews and recommendations."
        : "Join Curtain Call to rate films, highlight standout crew departments, and track your favorites.";
      document.title = isSignIn ? "Curtain Call — Sign In" : "Curtain Call — Create Account";
    }

    tabSignIn.addEventListener("click", () => setMode("signin"));
    tabSignUp.addEventListener("click", () => setMode("signup"));

    container.querySelectorAll(".btn-toggle-password").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $(btn.getAttribute("data-target"));
        if (!input) return;
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
        const icon = btn.querySelector("i");
        if (icon) icon.className = showing ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
      });
    });

    $("signup-birthday").setAttribute("max", new Date().toISOString().split("T")[0]);

    signInForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideBanner(msg);
      const identifier = $("signin-identifier").value.trim();
      const password = $("signin-password").value;
      if (!identifier || !password) {
        showBanner(msg, "error", "Please enter both your username/email and password.");
        return;
      }
      signInSubmit.disabled = true;
      signInSubmit.querySelector("span").textContent = "Signing In...";
      try {
        const user = await API.loginUser(identifier, password);
        saveUser(user);
        showBanner(msg, "success", `Welcome back, ${user.first_name}!`);
        global.setTimeout(() => navigate("home"), 550);
      } catch (err) {
        showBanner(msg, "error", formatError(err));
        signInSubmit.disabled = false;
        signInSubmit.querySelector("span").textContent = "Sign In";
      }
    });

    signUpForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideBanner(msg);
      const first_name = $("signup-first-name").value.trim();
      const last_name = $("signup-last-name").value.trim();
      const username = $("signup-username").value.trim();
      const email = $("signup-email").value.trim();
      const birthday = $("signup-birthday").value;
      const password = $("signup-password").value;
      const confirmPassword = $("signup-confirm-password").value;

      if (!first_name || !last_name || !username || !email || !birthday || !password) {
        showBanner(msg, "error", "Please fill out all required fields.");
        return;
      }
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
        showBanner(msg, "error", "Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.");
        return;
      }
      if (password.length < 8) {
        showBanner(msg, "error", "Password must be at least 8 characters long.");
        return;
      }
      if (password !== confirmPassword) {
        showBanner(msg, "error", "Passwords do not match. Please re-enter them.");
        return;
      }

      signUpSubmit.disabled = true;
      signUpSubmit.querySelector("span").textContent = "Creating Account...";
      try {
        const user = await API.registerUser({ username, password, email, first_name, last_name, birthday });
        saveUser(user);
        showBanner(msg, "success", `Account created for ${user.first_name} ${user.last_name}!`);
        global.setTimeout(() => navigate("home"), 550);
      } catch (err) {
        showBanner(msg, "error", formatError(err));
        signUpSubmit.disabled = false;
        signUpSubmit.querySelector("span").textContent = "Create Account";
      }
    });

    setMode(mode);
  }

  // =========================================
  // User Profile 
  // =========================================

  const PROFILE_TEMPLATE = `
    <div class="profile-panel">
      <div id="profile-message" class="auth-message" role="alert" aria-live="polite" hidden></div>

      <section id="profile-signed-out" class="profile-signed-out" hidden>
        <i class="fa-solid fa-ticket profile-signed-out-icon" aria-hidden="true"></i>
        <h2>Sign In to View Your Profile</h2>
        <p>Sign in to customize your profile picture, view your personal details, and track your movie review stats.</p>
        <button type="button" id="profile-go-signin" class="btn-primary">
          <span>Go to Sign In</span>
          <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>
      </section>

      <div id="profile-content" class="profile-content" hidden>
        <section class="profile-hero" aria-label="Profile Overview">
          <div class="profile-identity">
            <div class="avatar-column">
              <div class="avatar-frame">
                <img id="profile-avatar-img" class="avatar-image" src="" alt="Profile picture" hidden>
                <span id="profile-avatar-initials" class="avatar-initials">--</span>
                <button type="button" id="avatar-upload-trigger" class="avatar-upload-btn">
                  <i class="fa-solid fa-camera" aria-hidden="true"></i> Photo
                </button>
                <input type="file" id="avatar-file-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
              </div>
              <button type="button" id="avatar-remove-btn" class="avatar-remove-btn" hidden>Remove photo</button>
            </div>

            <div class="profile-name-block">
              <h2 id="profile-full-name" class="profile-full-name">Loading...</h2>
              <span id="profile-handle" class="profile-handle">@username</span>
              <span id="profile-member-since" class="profile-member-since">
                <i class="fa-solid fa-calendar-check" aria-hidden="true"></i>
                <span>Member since —</span>
              </span>
            </div>
          </div>

          <div class="profile-actions">
            <button type="button" id="btn-edit-profile" class="btn-details">
              <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Edit Profile
            </button>
            <button type="button" id="btn-sign-out" class="btn-secondary">
              <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign Out
            </button>
          </div>
        </section>

        <section class="profile-info-section" aria-label="Account Information">
          <div class="section-header">
            <h2 class="section-title">Account Information</h2>
            <span class="header-divider"></span>
          </div>

          <div id="profile-info-grid" class="info-grid">
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-user" aria-hidden="true"></i> First Name</span><span id="info-first-name" class="info-value">—</span></div>
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-user" aria-hidden="true"></i> Last Name</span><span id="info-last-name" class="info-value">—</span></div>
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-at" aria-hidden="true"></i> Username</span><span id="info-username" class="info-value">—</span></div>
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-envelope" aria-hidden="true"></i> Email</span><span id="info-email" class="info-value">—</span></div>
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-cake-candles" aria-hidden="true"></i> Birthday</span><span id="info-birthday" class="info-value">—</span></div>
            <div class="info-item"><span class="info-label"><i class="fa-solid fa-clock" aria-hidden="true"></i> Account Created</span><span id="info-created-at" class="info-value">—</span></div>
          </div>

          <form id="profile-edit-form" class="profile-edit-form" hidden>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="edit-first-name">First Name</label>
                <div class="input-wrapper"><i class="fa-solid fa-id-card input-icon" aria-hidden="true"></i><input type="text" id="edit-first-name" class="form-input" required></div>
              </div>
              <div class="form-group">
                <label class="form-label" for="edit-last-name">Last Name</label>
                <div class="input-wrapper"><i class="fa-solid fa-id-card input-icon" aria-hidden="true"></i><input type="text" id="edit-last-name" class="form-input" required></div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="edit-birthday">Birthday</label>
              <div class="input-wrapper"><i class="fa-solid fa-cake-candles input-icon" aria-hidden="true"></i><input type="date" id="edit-birthday" class="form-input" required></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="edit-favorite-genres">Favorite Genres</label>
              <div class="input-wrapper"><i class="fa-solid fa-film input-icon" aria-hidden="true"></i><input type="text" id="edit-favorite-genres" class="form-input" placeholder="Science Fiction, Thriller, Drama (comma-separated)"></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="edit-disliked-genres">Disliked Genres</label>
              <div class="input-wrapper"><i class="fa-solid fa-ban input-icon" aria-hidden="true"></i><input type="text" id="edit-disliked-genres" class="form-input" placeholder="Horror, Romance (comma-separated)"></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="edit-favorite-crew">Favorite Crew Members</label>
              <div class="input-wrapper"><i class="fa-solid fa-clapperboard input-icon" aria-hidden="true"></i><input type="text" id="edit-favorite-crew" class="form-input" placeholder="Denis Villeneuve, Hans Zimmer, Roger Deakins (comma-separated)"></div>
            </div>
            <div class="profile-edit-actions">
              <button type="button" id="btn-cancel-edit" class="btn-secondary">Cancel</button>
              <button type="submit" id="btn-save-profile" class="btn-primary"><span>Save Changes</span><i class="fa-solid fa-check" aria-hidden="true"></i></button>
            </div>
          </form>
        </section>

        <section class="profile-stats-section" aria-label="Reviewer Stats">
          <div class="section-header">
            <h2 class="section-title">Your Curtain Call Stats</h2>
            <span class="header-divider"></span>
          </div>

          <div class="stats-layout">
            <article class="stat-counter-card">
              <i class="fa-solid fa-star stat-counter-icon" aria-hidden="true"></i>
              <span id="stat-movies-reviewed" class="stat-counter-number">0</span>
              <span class="stat-counter-label">Movies Reviewed</span>
              <span id="stat-average-rating" class="stat-counter-sub">No movies reviewed yet</span>
            </article>

            <div class="stat-lists-column">
              <article class="stat-list-card">
                <h3 class="stat-list-title"><i class="fa-solid fa-film" aria-hidden="true"></i> Favorite Genres</h3>
                <div id="stat-favorite-genres" class="tag-list"></div>
              </article>
              <article class="stat-list-card">
                <h3 class="stat-list-title"><i class="fa-solid fa-ban" aria-hidden="true"></i> Disliked Genres</h3>
                <div id="stat-disliked-genres" class="tag-list"></div>
              </article>
              <article class="stat-list-card">
                <h3 class="stat-list-title"><i class="fa-solid fa-clapperboard" aria-hidden="true"></i> Favorite Crew Members</h3>
                <div id="stat-favorite-crew" class="tag-list"></div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  async function mountProfileView(container, navigate) {
    container.innerHTML = PROFILE_TEMPLATE;
    const $ = (id) => container.querySelector(`#${id}`);
    const msg = $("profile-message");
    const signedOut = $("profile-signed-out");
    const content = $("profile-content");
    let currentUser = null;

    $("profile-go-signin").addEventListener("click", () => navigate("signin"));

    function renderUser(user) {
      currentUser = user;
      $("profile-full-name").textContent = `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.username;
      $("profile-handle").textContent = `@${user.username}`;
      $("profile-member-since").querySelector("span").textContent = `Member since ${formatTimestamp(user.created_at)}`;

      const initials = `${(user.first_name || "")[0] || ""}${(user.last_name || "")[0] || ""}`.toUpperCase() || "?";
      $("profile-avatar-initials").textContent = initials;
      if (user.avatar_url) {
        $("profile-avatar-img").src = user.avatar_url;
        $("profile-avatar-img").hidden = false;
        $("profile-avatar-initials").hidden = true;
        $("avatar-remove-btn").hidden = false;
      } else {
        $("profile-avatar-img").src = "";
        $("profile-avatar-img").hidden = true;
        $("profile-avatar-initials").hidden = false;
        $("avatar-remove-btn").hidden = true;
      }

      $("info-first-name").textContent = user.first_name || "—";
      $("info-last-name").textContent = user.last_name || "—";
      $("info-username").textContent = user.username || "—";
      $("info-email").textContent = user.email || "—";
      $("info-birthday").textContent = formatDateOnly(user.birthday);
      $("info-created-at").textContent = formatTimestamp(user.created_at);

      renderTags($("stat-favorite-genres"), user.favorite_genres || [], "fa-solid fa-tag", "No favorite genres added yet — click Edit Profile to add some.");
      renderTags($("stat-disliked-genres"), user.disliked_genres || [], "fa-solid fa-ban", "No disliked genres set.");
      renderTags($("stat-favorite-crew"), user.favorite_crew || [], "fa-solid fa-user-tie", "No favorite crew members added yet — click Edit Profile to add some.");
    }

    function renderStats(stats) {
      const count = typeof stats.movies_reviewed === "number" ? stats.movies_reviewed : 0;
      $("stat-movies-reviewed").textContent = String(count);
      $("stat-average-rating").textContent =
        count > 0 && stats.average_rating != null
          ? `Average rating: ${stats.average_rating} / 10`
          : count > 0
            ? `${count} review${count === 1 ? "" : "s"} logged`
            : "No movies reviewed yet";
      renderTags($("stat-favorite-genres"), stats.favorite_genres || [], "fa-solid fa-tag", "No favorite genres added yet — click Edit Profile to add some.");
      renderTags($("stat-disliked-genres"), stats.disliked_genres || [], "fa-solid fa-ban", "No disliked genres set.");
      renderTags($("stat-favorite-crew"), stats.favorite_crew || [], "fa-solid fa-user-tie", "No favorite crew members added yet — click Edit Profile to add some.");
    }

    const fileInput = $("avatar-file-input");
    $("avatar-upload-trigger").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file || !currentUser) return;
      hideBanner(msg);
      try {
        const updated = await API.updateUser(currentUser.id, { avatar_url: await resizeImageToDataUrl(file, 256) });
        saveUser(updated);
        renderUser(updated);
        showBanner(msg, "success", "Profile picture updated.");
      } catch (err) {
        showBanner(msg, "error", formatError(err));
      }
    });

    $("avatar-remove-btn").addEventListener("click", async () => {
      if (!currentUser) return;
      hideBanner(msg);
      try {
        const updated = await API.updateUser(currentUser.id, { avatar_url: null });
        saveUser(updated);
        renderUser(updated);
        showBanner(msg, "success", "Profile picture removed.");
      } catch (err) {
        showBanner(msg, "error", formatError(err));
      }
    });

    $("btn-edit-profile").addEventListener("click", () => {
      if (!currentUser) return;
      hideBanner(msg);
      $("edit-first-name").value = currentUser.first_name || "";
      $("edit-last-name").value = currentUser.last_name || "";
      $("edit-birthday").value = currentUser.birthday ? String(currentUser.birthday).split("T")[0] : "";
      $("edit-birthday").setAttribute("max", new Date().toISOString().split("T")[0]);
      $("edit-favorite-genres").value = (currentUser.favorite_genres || []).join(", ");
      $("edit-disliked-genres").value = (currentUser.disliked_genres || []).join(", ");
      $("edit-favorite-crew").value = (currentUser.favorite_crew || []).join(", ");
      $("profile-info-grid").hidden = true;
      $("profile-edit-form").hidden = false;
      $("btn-edit-profile").hidden = true;
    });

    $("btn-cancel-edit").addEventListener("click", () => {
      $("profile-edit-form").hidden = true;
      $("profile-info-grid").hidden = false;
      $("btn-edit-profile").hidden = false;
    });

    $("profile-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!currentUser) return;
      hideBanner(msg);
      const first_name = $("edit-first-name").value.trim();
      const last_name = $("edit-last-name").value.trim();
      const birthday = $("edit-birthday").value;
      const splitList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
      if (!first_name || !last_name || !birthday) {
        showBanner(msg, "error", "First name, last name, and birthday are required.");
        return;
      }
      const saveBtn = $("btn-save-profile");
      saveBtn.disabled = true;
      saveBtn.querySelector("span").textContent = "Saving...";
      try {
        const updated = await API.updateUser(currentUser.id, {
          first_name,
          last_name,
          birthday,
          favorite_genres: splitList($("edit-favorite-genres").value),
          disliked_genres: splitList($("edit-disliked-genres").value),
          favorite_crew: splitList($("edit-favorite-crew").value),
        });
        saveUser(updated);
        renderUser(updated);
        $("profile-edit-form").hidden = true;
        $("profile-info-grid").hidden = false;
        $("btn-edit-profile").hidden = false;
        showBanner(msg, "success", "Profile changes saved.");
      } catch (err) {
        showBanner(msg, "error", formatError(err));
      } finally {
        saveBtn.disabled = false;
        saveBtn.querySelector("span").textContent = "Save Changes";
      }
    });

    $("btn-sign-out").addEventListener("click", () => {
      saveUser(null);
      navigate("signin");
    });

    const stored = loadUser();
    if (!stored || !stored.id) {
      signedOut.hidden = false;
      content.hidden = true;
      return;
    }

    signedOut.hidden = true;
    content.hidden = false;
    renderUser(stored);

    try {
      const [freshUser, stats] = await Promise.all([API.getUser(stored.id), API.getUserStats(stored.id)]);
      if (!container.querySelector("#profile-content")) return;
      saveUser(freshUser);
      renderUser(freshUser);
      renderStats(stats);
    } catch (err) {
      if (!container.querySelector("#profile-content")) return;
      if (err && err.status === 404) {
        saveUser(null);
        signedOut.hidden = false;
        content.hidden = true;
        return;
      }
      showBanner(msg, "error", `Showing cached profile — ${formatError(err)}`);
    }
  }

  // =========================================
  // Reviews
  // =========================================

  const REVIEWS_TEMPLATE = `
    <div class="reviews-panel">
      <div id="reviews-message" class="auth-message" role="alert" aria-live="polite" hidden></div>

      <section class="reviews-search-section" aria-label="Search Movies">
        <div class="section-header">
          <h2 class="section-title">Find a Movie to Review</h2>
          <span class="header-divider"></span>
        </div>

        <form id="movie-search-form" class="movie-search-bar" novalidate>
          <div class="input-wrapper search-input-grow">
            <i class="fa-solid fa-magnifying-glass input-icon" aria-hidden="true"></i>
            <input type="search" id="movie-search-input" class="form-input" placeholder="Search The Movie Database (e.g. Dune, Star Wars, Oppenheimer)..." autocomplete="off" required>
          </div>
          <button type="submit" id="movie-search-btn" class="btn-primary search-submit-btn">
            <span>Search</span>
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          </button>
        </form>

        <div id="movie-search-status" class="search-status" hidden></div>
        <div id="movie-search-results" class="search-results-grid" hidden></div>
      </section>

      <section id="review-composer-section" class="review-composer-section" aria-label="Write a Review" hidden>
        <div class="section-header">
          <h2 class="section-title">Write Your Review</h2>
          <span class="header-divider"></span>
        </div>

        <div id="selected-movie-banner" class="selected-movie-banner"></div>

        <div id="composer-signin-prompt" class="composer-signin-prompt" hidden>
          <i class="fa-solid fa-lock" aria-hidden="true"></i>
          <span>Sign in to publish your review to Curtain Call.</span>
          <button type="button" id="composer-go-signin" class="btn-details">
            Sign In <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>

        <form id="review-form" class="review-form" novalidate>
          <div class="form-group">
            <div class="rating-header">
              <label class="form-label" for="review-rating">Your Rating</label>
              <span id="review-rating-value" class="rating-readout">8.0 / 10</span>
            </div>
            <input type="range" id="review-rating" class="rating-slider" min="0.5" max="10" step="0.5" value="8">
            <div class="rating-scale"><span>0.5</span><span>5.0</span><span>10.0</span></div>
          </div>

          <div class="form-group">
            <span class="form-label">Standout Departments</span>
            <div id="composer-departments" class="chip-selector"></div>
          </div>

          <div id="composer-crew-group" class="form-group" hidden>
            <span class="form-label">Standout Crew Members (from TMDB)</span>
            <div id="composer-crew" class="chip-selector"></div>
          </div>

          <div class="form-group">
            <label class="form-label" for="review-comment">Review Notes</label>
            <textarea id="review-comment" class="form-textarea" rows="4" maxlength="4000" placeholder="What stood out about the craft, visuals, sound, or performances?"></textarea>
          </div>

          <div id="composer-message" class="auth-message" role="alert" aria-live="polite" hidden></div>

          <div class="profile-edit-actions">
            <button type="button" id="btn-cancel-review" class="btn-secondary">Change Movie</button>
            <button type="submit" id="btn-submit-review" class="btn-primary">
              <span>Publish Review</span>
              <i class="fa-solid fa-feather-pointed" aria-hidden="true"></i>
            </button>
          </div>
        </form>
      </section>

      <section class="reviews-feed-section" aria-label="Published Reviews">
        <div class="section-header">
          <h2 class="section-title">Reviews</h2>
          <span class="header-divider"></span>
          <div class="feed-filter-tabs" role="tablist" aria-label="Filter Reviews">
            <button type="button" id="filter-all-reviews" class="feed-filter-btn active" role="tab" aria-selected="true">All Reviews</button>
            <button type="button" id="filter-my-reviews" class="feed-filter-btn" role="tab" aria-selected="false">My Reviews</button>
          </div>
        </div>
        <div id="reviews-list" class="reviews-list"></div>
      </section>
    </div>
  `;

  async function mountReviewsView(container, navigate) {
    container.innerHTML = REVIEWS_TEMPLATE;
    const $ = (id) => container.querySelector(`#${id}`);
    const topMsg = $("reviews-message");
    const composerMsg = $("composer-message");
    const currentUser = loadUser();

    let selectedMovie = null;
    let selectedDepts = new Set();
    let selectedCrewMap = new Map();
    let activeFilter = "all";

    const alive = () => Boolean(container.querySelector("#reviews-list"));
    const clearAllMessages = () => {
      hideBanner(topMsg);
      hideBanner(composerMsg);
    };

    $("composer-go-signin").addEventListener("click", () => navigate("signin"));

    function renderChips(target, items, selectedSet, getLabel, getValue) {
      target.innerHTML = "";
      items.forEach((item) => {
        const val = getValue(item);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `select-chip${selectedSet.has(val) ? " selected" : ""}`;
        btn.textContent = getLabel(item);
        btn.addEventListener("click", () => {
          if (selectedSet.has(val)) {
            selectedSet.delete(val);
            btn.classList.remove("selected");
          } else {
            selectedSet.add(val);
            btn.classList.add("selected");
          }
        });
        target.appendChild(btn);
      });
    }

    function renderSelectedMovie(movie) {
      const banner = $("selected-movie-banner");
      banner.innerHTML = "";
      const img = document.createElement("img");
      img.className = "selected-movie-poster";
      img.src = movie.poster_url || placeholderPoster(movie.title);
      img.alt = `${movie.title} poster`;

      const details = document.createElement("div");
      details.className = "selected-movie-details";

      const title = document.createElement("h3");
      title.className = "selected-movie-title";
      title.textContent = movie.release_year ? `${movie.title} (${movie.release_year})` : movie.title;

      const meta = document.createElement("div");
      meta.className = "selected-movie-meta";
      if (movie.genres && movie.genres.length) {
        const s = document.createElement("span");
        s.textContent = movie.genres.join(" • ");
        meta.appendChild(s);
      }
      if (movie.runtime) {
        const s = document.createElement("span");
        s.textContent = `${movie.runtime} min`;
        meta.appendChild(s);
      }
      if (movie.vote_average != null) {
        const s = document.createElement("span");
        s.className = "tmdb-score-badge";
        s.innerHTML = `<i class="fa-solid fa-star" aria-hidden="true"></i> TMDB ${movie.vote_average}`;
        meta.appendChild(s);
      }

      const overview = document.createElement("p");
      overview.className = "selected-movie-overview";
      overview.textContent = movie.overview || "No synopsis available.";

      details.append(title, meta, overview);
      banner.append(img, details);
    }

    async function selectMovie(movie) {
      clearAllMessages();
      selectedDepts = new Set();
      selectedCrewMap = new Map();
      $("review-rating").value = "8";
      $("review-rating-value").textContent = "8.0 / 10";
      $("review-comment").value = "";

      selectedMovie = { ...movie, genres: [], crew: [] };
      renderSelectedMovie(selectedMovie);
      renderChips($("composer-departments"), DEPARTMENTS, selectedDepts, (d) => d, (d) => d);
      $("composer-crew-group").hidden = true;

      const signedIn = Boolean(currentUser && currentUser.id);
      $("composer-signin-prompt").hidden = signedIn;
      $("review-form").hidden = !signedIn;
      $("review-composer-section").hidden = false;
      $("review-composer-section").scrollIntoView({ behavior: "smooth", block: "nearest" });

      try {
        const full = await API.getMovieDetails(movie.tmdb_id);
        if (!alive() || !selectedMovie || selectedMovie.tmdb_id !== movie.tmdb_id) return;
        selectedMovie = full;
        renderSelectedMovie(full);
        if (full.crew && full.crew.length) {
          $("composer-crew-group").hidden = false;
          const crewTarget = $("composer-crew");
          crewTarget.innerHTML = "";
          full.crew.forEach((m) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "select-chip";
            btn.textContent = m.job ? `${m.name} (${m.job})` : m.name;
            btn.addEventListener("click", () => {
              if (selectedCrewMap.has(m.id)) {
                selectedCrewMap.delete(m.id);
                btn.classList.remove("selected");
              } else {
                selectedCrewMap.set(m.id, m.name);
                btn.classList.add("selected");
              }
            });
            crewTarget.appendChild(btn);
          });
        }
      } catch (_) {}
    }

    function renderSearchResults(movies) {
      const results = $("movie-search-results");
      const statusEl = $("movie-search-status");
      results.innerHTML = "";
      if (!movies || movies.length === 0) {
        results.hidden = true;
        statusEl.textContent = "No movies matched your search. Try another title.";
        statusEl.hidden = false;
        return;
      }
      statusEl.textContent = `Showing ${movies.length} result${movies.length === 1 ? "" : "s"} from The Movie Database (TMDB):`;
      statusEl.hidden = false;
      results.hidden = false;

      movies.forEach((movie) => {
        const card = document.createElement("article");
        card.className = "search-result-card";
        const poster = document.createElement("img");
        poster.className = "search-result-poster";
        poster.src = movie.poster_url || placeholderPoster(movie.title);
        poster.alt = `${movie.title} poster`;
        poster.loading = "lazy";

        const body = document.createElement("div");
        body.className = "search-result-body";
        const heading = document.createElement("h3");
        heading.className = "search-result-title";
        heading.textContent = movie.release_year ? `${movie.title} (${movie.release_year})` : movie.title;
        const overview = document.createElement("p");
        overview.className = "search-result-overview";
        overview.textContent = movie.overview || "No description available.";

        const footer = document.createElement("div");
        footer.className = "search-result-footer";
        if (movie.vote_average != null) {
          const score = document.createElement("span");
          score.className = "tmdb-score-badge";
          score.innerHTML = `<i class="fa-solid fa-star" aria-hidden="true"></i> ${movie.vote_average}`;
          footer.appendChild(score);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-details btn-compact";
        btn.innerHTML = `Review <i class="fa-solid fa-pen" aria-hidden="true"></i>`;
        btn.addEventListener("click", () => selectMovie(movie));
        footer.appendChild(btn);

        body.append(heading, overview, footer);
        card.append(poster, body);
        results.appendChild(card);
      });
    }

    async function loadReviews() {
      const listEl = $("reviews-list");
      listEl.innerHTML = `<p class="search-status">Loading reviews...</p>`;
      try {
        const params = activeFilter === "mine" && currentUser && currentUser.id ? { userId: currentUser.id } : {};
        const reviews = await API.listReviews(params);
        if (!alive()) return;
        listEl.innerHTML = "";
        if (!reviews || reviews.length === 0) {
          listEl.innerHTML = `<div class="reviews-empty"><i class="fa-solid fa-film" aria-hidden="true"></i><p>${
            activeFilter === "mine"
              ? "You haven't published any reviews yet. Search for a movie above to add your first review!"
              : "No reviews have been published yet. Search for a movie above to be the first!"
          }</p></div>`;
          return;
        }
        reviews.forEach((rev) => {
          const card = document.createElement("article");
          card.className = "review-card";
          const poster = document.createElement("img");
          poster.className = "review-card-poster";
          poster.src = rev.poster_url || placeholderPoster(rev.movie_title);
          poster.alt = `${rev.movie_title} poster`;
          poster.loading = "lazy";

          const body = document.createElement("div");
          body.className = "review-card-body";
          const topRow = document.createElement("div");
          topRow.className = "review-card-top";

          const titleWrap = document.createElement("div");
          const title = document.createElement("h3");
          title.className = "review-card-title";
          title.textContent = rev.release_year ? `${rev.movie_title} (${rev.release_year})` : rev.movie_title;
          const byline = document.createElement("span");
          byline.className = "review-card-byline";
          byline.textContent = `Reviewed by @${rev.username}${rev.created_at ? ` • ${formatTimestamp(rev.created_at, "short")}` : ""}`;
          titleWrap.append(title, byline);

          const badges = document.createElement("div");
          badges.className = "review-card-badges";
          const ratingBadge = document.createElement("span");
          ratingBadge.className = "review-rating-badge";
          ratingBadge.innerHTML = `<i class="fa-solid fa-star" aria-hidden="true"></i> ${Number(rev.rating).toFixed(1)} / 10`;
          badges.appendChild(ratingBadge);

          if (currentUser && currentUser.id === rev.user_id) {
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "btn-icon-delete";
            delBtn.title = "Delete review";
            delBtn.innerHTML = `<i class="fa-solid fa-trash" aria-hidden="true"></i>`;
            delBtn.addEventListener("click", async () => {
              clearAllMessages();
              try {
                await API.deleteReview(rev.id);
                showBanner(topMsg, "success", `Deleted review for ${rev.movie_title}.`);
                loadReviews();
              } catch (err) {
                showBanner(topMsg, "error", formatError(err));
              }
            });
            badges.appendChild(delBtn);
          }

          topRow.append(titleWrap, badges);
          body.appendChild(topRow);

          if (rev.comment) {
            const commentEl = document.createElement("p");
            commentEl.className = "review-card-comment";
            commentEl.textContent = rev.comment;
            body.appendChild(commentEl);
          }

          const chips = document.createElement("div");
          chips.className = "tag-list";
          (rev.liked_departments || []).forEach((d) => {
            const t = document.createElement("span");
            t.className = "stat-tag";
            t.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>`;
            const s = document.createElement("span");
            s.textContent = d;
            t.appendChild(s);
            chips.appendChild(t);
          });
          (rev.liked_crew || []).forEach((c) => {
            const t = document.createElement("span");
            t.className = "stat-tag";
            t.innerHTML = `<i class="fa-solid fa-user-tie" aria-hidden="true"></i>`;
            const s = document.createElement("span");
            s.textContent = c;
            t.appendChild(s);
            chips.appendChild(t);
          });
          if (chips.childNodes.length) body.appendChild(chips);

          card.append(poster, body);
          listEl.appendChild(card);
        });
      } catch (err) {
        if (!alive()) return;
        listEl.innerHTML = "";
        showBanner(topMsg, "error", formatError(err));
      }
    }

    $("review-rating").addEventListener("input", () => {
      $("review-rating-value").textContent = `${Number($("review-rating").value).toFixed(1)} / 10`;
    });

    $("btn-cancel-review").addEventListener("click", () => {
      selectedMovie = null;
      $("review-composer-section").hidden = true;
      $("movie-search-input").focus();
    });

    $("movie-search-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAllMessages();
      const q = $("movie-search-input").value.trim();
      if (!q) {
        showBanner(topMsg, "error", "Enter a movie title to search.");
        return;
      }
      const btn = $("movie-search-btn");
      btn.disabled = true;
      btn.querySelector("span").textContent = "Searching...";
      $("movie-search-status").textContent = `Searching TMDB for "${q}"...`;
      $("movie-search-status").hidden = false;
      try {
        const movies = await API.searchMovies(q);
        if (!alive()) return;
        renderSearchResults(movies);
      } catch (err) {
        if (!alive()) return;
        $("movie-search-results").hidden = true;
        $("movie-search-status").hidden = true;
        showBanner(topMsg, "error", formatError(err));
      } finally {
        if (alive()) {
          btn.disabled = false;
          btn.querySelector("span").textContent = "Search";
        }
      }
    });

    $("review-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAllMessages();
      if (!currentUser || !currentUser.id) {
        showBanner(composerMsg, "error", "Please sign in before publishing a review.");
        return;
      }
      if (!selectedMovie) {
        showBanner(composerMsg, "error", "Select a movie first.");
        return;
      }
      const btn = $("btn-submit-review");
      btn.disabled = true;
      btn.querySelector("span").textContent = "Publishing...";
      try {
        await API.createReview({
          user_id: currentUser.id,
          movie_id: selectedMovie.tmdb_id,
          movie_title: selectedMovie.title,
          release_year: selectedMovie.release_year || null,
          poster_url: selectedMovie.poster_url || null,
          genres: selectedMovie.genres || [],
          rating: Number($("review-rating").value),
          liked_departments: Array.from(selectedDepts),
          liked_crew: Array.from(selectedCrewMap.values()),
          liked_crew_ids: Array.from(selectedCrewMap.keys()),
          comment: $("review-comment").value.trim(),
        });
        if (!alive()) return;
        const reviewedTitle = selectedMovie.title;
        selectedMovie = null;
        $("review-composer-section").hidden = true;
        showBanner(topMsg, "success", `Your review for "${reviewedTitle}" has been published!`);
        topMsg.scrollIntoView({ behavior: "smooth", block: "nearest" });
        loadReviews();
      } catch (err) {
        if (!alive()) return;
        showBanner(composerMsg, "error", formatError(err));
      } finally {
        if (alive()) {
          btn.disabled = false;
          btn.querySelector("span").textContent = "Publish Review";
        }
      }
    });

    $("filter-all-reviews").addEventListener("click", () => {
      activeFilter = "all";
      $("filter-all-reviews").classList.add("active");
      $("filter-my-reviews").classList.remove("active");
      loadReviews();
    });

    $("filter-my-reviews").addEventListener("click", () => {
      if (!currentUser || !currentUser.id) {
        showBanner(topMsg, "error", "Sign in to filter by your own reviews.");
        return;
      }
      activeFilter = "mine";
      $("filter-my-reviews").classList.add("active");
      $("filter-all-reviews").classList.remove("active");
      loadReviews();
    });

    loadReviews();

    if (pendingReviewMovie) {
      const movieToReview = pendingReviewMovie;
      pendingReviewMovie = null;
      selectMovie(movieToReview);
    }
  }

  // =========================================
  // View: Home — Active Recommendations (#home)
  // =========================================

  let pendingReviewMovie = null;

  async function mountHomeView(container, navigate) {
    const user = loadUser();
    container.innerHTML = `
      <section class="recommendations-section">
        <div class="section-header">
          <h2 class="section-title">Recommended Movies</h2>
          <span class="header-divider"></span>
          <button type="button" id="home-refresh-btn" class="btn-secondary btn-compact" ${user && user.id ? "" : "hidden"}>
            <i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh
          </button>
        </div>
        <div id="home-message" class="auth-message" role="alert" aria-live="polite" hidden></div>
        <div id="home-movie-list" class="movie-list"></div>
      </section>
    `;

    const $ = (id) => container.querySelector(`#${id}`);
    const listEl = $("home-movie-list");
    const msgEl = $("home-message");
    const refreshBtn = $("home-refresh-btn");
    const alive = () => Boolean(container.querySelector("#home-movie-list"));

    if (!user || !user.id) {
      listEl.innerHTML = `
        <div class="profile-signed-out">
          <i class="fa-solid fa-masks-theater profile-signed-out-icon" aria-hidden="true"></i>
          <h2>Personalized Recommendations</h2>
          <p>Sign in and review a few movies to unlock recommendations tailored to your favorite crew members and genres.</p>
          <button type="button" id="home-go-signin" class="btn-primary">
            <span>Sign In</span>
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>
      `;
      $("home-go-signin").addEventListener("click", () => navigate("signin"));
      return;
    }

    function renderRecommendationCards(items) {
      listEl.innerHTML = "";
      if (!items || items.length === 0) {
        listEl.innerHTML = `
          <div class="reviews-empty">
            <i class="fa-solid fa-clapperboard" aria-hidden="true"></i>
            <p>No recommendations left right now. Head to the Reviews tab to rate a movie or highlight crew members you like!</p>
            <button type="button" id="home-go-reviews" class="btn-details">
              Go to Reviews <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
        `;
        $("home-go-reviews").addEventListener("click", () => navigate("reviews"));
        return;
      }

      items.forEach((movie, idx) => {
        if (idx > 0) {
          const hr = document.createElement("hr");
          hr.className = "card-divider";
          listEl.appendChild(hr);
        }

        const article = document.createElement("article");
        article.className = "movie-card";

        const posterWrap = document.createElement("div");
        posterWrap.className = "movie-poster";
        const img = document.createElement("img");
        img.src =
          movie.backdrop_url ||
          movie.poster_url ||
          `https://placehold.co/480x270/0a1026/e5b85c?text=${encodeURIComponent(movie.title)}`;
        img.alt = `${movie.title} backdrop`;
        img.loading = "lazy";
        posterWrap.appendChild(img);

        const info = document.createElement("div");
        info.className = "movie-info";

        const titleRow = document.createElement("div");
        titleRow.className = "rec-title-row";
        const h3 = document.createElement("h3");
        h3.className = "movie-title";
        h3.textContent = movie.release_year ? `${movie.title} (${movie.release_year})` : movie.title;
        titleRow.appendChild(h3);

        const metaRow = document.createElement("div");
        metaRow.className = "rec-meta-row";
        const scoreBadge = document.createElement("span");
        scoreBadge.className = "rec-score-badge";
        scoreBadge.innerHTML = `<i class="fa-solid fa-award" aria-hidden="true"></i> Score ${movie.score >= 0 ? `+${movie.score}` : movie.score}`;
        metaRow.appendChild(scoreBadge);

        if (movie.vote_average != null) {
          const tmdbBadge = document.createElement("span");
          tmdbBadge.className = "tmdb-score-badge";
          tmdbBadge.innerHTML = `<i class="fa-solid fa-star" aria-hidden="true"></i> TMDB ${movie.vote_average}`;
          metaRow.appendChild(tmdbBadge);
        }
        if (movie.genres && movie.genres.length) {
          const g = document.createElement("span");
          g.className = "rec-genres";
          g.textContent = movie.genres.slice(0, 3).join(" • ");
          metaRow.appendChild(g);
        }

        const reason = document.createElement("p");
        reason.className = "movie-reason";
        reason.textContent = movie.reason;

        info.append(titleRow, metaRow, reason);

        const actions = document.createElement("div");
        actions.className = "movie-action rec-actions";

        const reviewBtn = document.createElement("button");
        reviewBtn.className = "btn-details";
        reviewBtn.type = "button";
        reviewBtn.innerHTML = `Review <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>`;
        reviewBtn.addEventListener("click", () => {
          pendingReviewMovie = movie;
          navigate("reviews");
        });

        const dismissBtn = document.createElement("button");
        dismissBtn.className = "btn-dismiss";
        dismissBtn.type = "button";
        dismissBtn.innerHTML = `<i class="fa-solid fa-xmark" aria-hidden="true"></i> Dismiss`;
        dismissBtn.addEventListener("click", async () => {
          dismissBtn.disabled = true;
          hideBanner(msgEl);
          try {
            const updatedUser = await API.dismissMovie(user.id, movie.tmdb_id);
            saveUser(updatedUser);
            const remaining = items.filter((m) => m.tmdb_id !== movie.tmdb_id);
            items.length = 0;
            items.push(...remaining);
            if (alive()) renderRecommendationCards(items);
          } catch (err) {
            dismissBtn.disabled = false;
            if (alive()) showBanner(msgEl, "error", formatError(err));
          }
        });

        actions.append(reviewBtn, dismissBtn);
        article.append(posterWrap, info, actions);
        listEl.appendChild(article);
      });
    }

    async function loadRecommendations() {
      hideBanner(msgEl);
      listEl.innerHTML = `<p class="search-status">Scoring recommendations from TMDB based on your reviews and favorite crew...</p>`;
      refreshBtn.disabled = true;
      try {
        const recs = await API.getRecommendations(user.id, 10);
        if (!alive()) return;
        renderRecommendationCards(recs);
      } catch (err) {
        if (!alive()) return;
        listEl.innerHTML = "";
        showBanner(msgEl, "error", formatError(err));
      } finally {
        if (alive()) refreshBtn.disabled = false;
      }
    }

    refreshBtn.addEventListener("click", loadRecommendations);
    loadRecommendations();
  }

  // =========================================
  // SPA Router
  // =========================================

  const mainNav = document.querySelector(".main-nav");
  const appContent = document.getElementById("app-content");
  const navLinks = Array.from(document.querySelectorAll(".main-nav .nav-link[data-view]"));
  if (!appContent) return;

  const PLACEHOLDERS = {
    browse: {
      title: "Browse Movies",
      icon: "fa-solid fa-clapperboard",
      description: "Browse the catalog, search by cast or behind-the-scenes crew, and discover curated films — coming soon.",
    },
    settings: {
      title: "Settings",
      icon: "fa-solid fa-gear",
      description: "Manage account preferences, privacy options, and notification settings — coming soon.",
    },
  };

  function resolveViewFromHash() {
    const raw = (global.location.hash || "").replace(/^#/, "").toLowerCase();
    if (!raw) return loadUser() ? "home" : "signin";
    if (["signin", "signup", "home", "browse", "profile", "reviews", "settings"].includes(raw)) return raw;
    return "home";
  }

  function navigate(view) {
    const nextHash = `#${view}`;
    if (global.location.hash !== nextHash) {
      global.history.pushState(null, "", nextHash);
    }
    renderView(view);
  }

  function renderView(view) {
    const isAuth = view === "signin" || view === "signup";
    if (mainNav) mainNav.hidden = isAuth;
    appContent.classList.toggle("auth-panel", isAuth);

    navLinks.forEach((link) => {
      const match = link.getAttribute("data-view") === view;
      link.classList.toggle("active", match);
      if (match) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (isAuth) {
      mountAuthView(appContent, view, navigate);
      return;
    }
    if (view === "home") {
      document.title = "Curtain Call";
      mountHomeView(appContent, navigate);
      return;
    }
    if (view === "profile") {
      document.title = "Curtain Call — Profile";
      mountProfileView(appContent, navigate);
      return;
    }
    if (view === "reviews") {
      document.title = "Curtain Call — Reviews";
      mountReviewsView(appContent, navigate);
      return;
    }
    if (PLACEHOLDERS[view]) {
      const meta = PLACEHOLDERS[view];
      document.title = `Curtain Call — ${meta.title}`;
      appContent.innerHTML = `
        <section class="placeholder-view">
          <div class="section-header"><h2 class="section-title">${meta.title}</h2><span class="header-divider"></span></div>
          <div class="profile-signed-out">
            <i class="${meta.icon} profile-signed-out-icon" aria-hidden="true"></i>
            <h2>${meta.title}</h2>
            <p>${meta.description}</p>
          </div>
        </section>
      `;
    }
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(link.getAttribute("data-view") || "home");
    });
  });

  global.addEventListener("hashchange", () => renderView(resolveViewFromHash()));
  global.addEventListener("popstate", () => renderView(resolveViewFromHash()));

  renderView(resolveViewFromHash());
})(window);
