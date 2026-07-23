// ── State ──────────────────────────────────────────────────────
let currentLat = null;
let currentLng = null;
let destLat = null;
let destLng = null;
let destName = null;
let alarmMinutes = 10;
let alarmSet = false;
let alarmTriggered = false;
let currentDurationMin = null;
let suggestionTimeout = null;
let currentMapUrl = null;
let isGeocodingInProgress = false;
let isVoiceEnabled = localStorage.getItem("voiceEnabled") === "true";
let isDarkMode = localStorage.getItem("darkMode") === "true";
let trainDetectedLastTime = false;
let consecutiveTrainDetections = 0;
let recentDestinations = JSON.parse(localStorage.getItem("recentDestinations") || "[]");

// Offline state
let offlineMode = !navigator.onLine;
let offlineCountdownInterval = null;

// Journey state
let journeyStarted = false;

// ETA live refresh
let etaRefreshInterval = null;
const ETA_REFRESH_MS   = 60000;

// Leaflet state
let map = null;
let mobileMap = null;
let userMarker = null;
let mobileUserMarker = null;
let destMarker = null;
let mobileDestMarker = null;
let routePolyline = null;
let mobileRoutePolyline = null;

// ── Motion Tracker ─────────────────────────────────────────────
class MotionTracker {
    constructor() {
        this.speedWindow = [];
        this.maxWindow = 5;
        this.lastPosition = null;
        this.lastPositionTime = null;
        this.isMoving = false;
        this.avgSpeed = 0;
        this.movingThreshold = 2;
        this.onMovingChange = null;
    }

    addPosition(lat, lng) {
        const now = Date.now();
        if (this.lastPosition === null) {
            this.lastPosition = { lat, lng };
            this.lastPositionTime = now;
            return;
        }
        const timeDiffSec = (now - this.lastPositionTime) / 1000;
        if (timeDiffSec < 10) return;
        const distanceM = this._haversine(this.lastPosition.lat, this.lastPosition.lng, lat, lng);
        const speedKmh = (distanceM / 1000) / (timeDiffSec / 3600);
        this.speedWindow.push({ speed: speedKmh, timestamp: now });
        if (this.speedWindow.length > this.maxWindow) this.speedWindow.shift();
        this.lastPosition = { lat, lng };
        this.lastPositionTime = now;
        this._analyze();
    }

    _analyze() {
        if (this.speedWindow.length === 0) {
            this.avgSpeed = 0;
            this._setMoving(false);
            return;
        }
        const total = this.speedWindow.reduce((sum, s) => sum + s.speed, 0);
        this.avgSpeed = total / this.speedWindow.length;
        const wasMoving = this.isMoving;
        this._setMoving(this.avgSpeed > this.movingThreshold);
        if (wasMoving !== this.isMoving && this.onMovingChange) {
            this.onMovingChange(this.isMoving, this.avgSpeed);
        }
    }

    _setMoving(value) { this.isMoving = value; }

    predictETA(remainingDistanceKm) {
        if (this.avgSpeed < this.movingThreshold || remainingDistanceKm <= 0) return null;
        return Math.round((remainingDistanceKm / this.avgSpeed) * 60);
    }

    getSummary() {
        return {
            isMoving: this.isMoving,
            avgSpeed: Math.round(this.avgSpeed * 10) / 10,
            samplesCount: this.speedWindow.length,
            maxSamples: this.maxWindow,
            windowFull: this.speedWindow.length >= this.maxWindow
        };
    }

    reset() {
        this.speedWindow = [];
        this.lastPosition = null;
        this.lastPositionTime = null;
        this.isMoving = false;
        this.avgSpeed = 0;
    }

    _haversine(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
        const dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
}

const motionTracker = new MotionTracker();

// Kalman Filter
class KalmanFilter {
    constructor(processNoise = 0.001, measurementNoise = 0.1) {
        this.processNoise = processNoise;
        this.measurementNoise = measurementNoise;
        this.estimatedValue = null;
        this.errorCovariance = 1;
    }

    filter(measurement) {
        if (this.estimatedValue === null) {
            this.estimatedValue = measurement;
            return measurement;
        }
        const predictedValue = this.estimatedValue;
        const predictedErrorCovariance = this.errorCovariance + this.processNoise;
        const kalmanGain = predictedErrorCovariance / (predictedErrorCovariance + this.measurementNoise);
        this.estimatedValue = predictedValue + kalmanGain * (measurement - predictedValue);
        this.errorCovariance = (1 - kalmanGain) * predictedErrorCovariance;
        return this.estimatedValue;
    }
}

const latFilter = new KalmanFilter();
const lngFilter = new KalmanFilter();

// Throttle state
let lastCheckTime = 0;
let checkIntervalId = null;
let lastRouteLat = null;
let lastRouteLng = null;
const CHECK_INTERVAL_MS = 30000;
const ROUTE_MIN_MOVE_M  = 50;

// ── Element helper ─────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function sanitizeTimeText(timeStr = "") {
    return String(timeStr).replace(/\s*\(\s*ola\s*maps\s*\)/i, "").trim();
}

function applyTrafficColor(durationMin) {
    const mins = Number(durationMin);
    if (!Number.isFinite(mins) || mins <= 0) return;

    let cls = "traffic-low";
    if (mins > 90) cls = "traffic-high";
    else if (mins > 45) cls = "traffic-medium";

    ["time-value", "mobile-time-value"].forEach(id => {
        const elem = el(id);
        if (!elem) return;
        elem.classList.remove("traffic-low", "traffic-medium", "traffic-high");
        elem.classList.add(cls);
    });
}

// ── Toast ──────────────────────────────────────────────────────
function showToast(text) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── Voice ──────────────────────────────────────────────────────
function speak(text) {
    if (!isVoiceEnabled || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
}

// ── Theme ──────────────────────────────────────────────────────
function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle("dark-mode", isDarkMode);
    localStorage.setItem("darkMode", isDarkMode);
    updateThemeButtons();
}

function updateThemeButtons() {
    ["theme-toggle", "mobile-theme-toggle"].forEach(id => {
        const btn = el(id);
        if (btn) {
            btn.textContent = isDarkMode ? "☀️" : "🌙";
            btn.classList.toggle("active", isDarkMode);
        }
    });
}

function toggleVoice() {
    isVoiceEnabled = !isVoiceEnabled;
    localStorage.setItem("voiceEnabled", isVoiceEnabled);
    updateVoiceButtons();
    if (isVoiceEnabled) speak("Voice alerts enabled");
}

function updateVoiceButtons() {
    ["voice-toggle", "mobile-voice-toggle"].forEach(id => {
        const btn = el(id);
        if (btn) {
            btn.textContent = isVoiceEnabled ? "🔊" : "🔇";
            btn.classList.toggle("active", isVoiceEnabled);
        }
    });
}

// ── GPS Dot ────────────────────────────────────────────────────
function setGpsDot(state) {
    ["gps-dot", "mobile-gps-dot"].forEach(id => {
        const dot = el(id);
        if (!dot) return;
        dot.className = `gps-dot gps-dot--${state}`;
    });
}

// ── Loading Bar ────────────────────────────────────────────────
function showLoadingBar(show) {
    ["loading-bar", "mobile-loading-bar"].forEach(id => {
        if (el(id)) el(id).classList.toggle("hidden", !show);
    });
}

// ── Update Status ──────────────────────────────────────────────
function updateStatus(text) {
    if (el("status")) el("status").textContent = text;
    if (el("mobile-status")) el("mobile-status").textContent = text;
}

function showOffline(show) {
    ["offline-badge", "mobile-offline-badge"].forEach(id => {
        if (el(id)) el(id).classList.toggle("hidden", !show);
    });
}

function goOffline() {
    offlineMode = true;
    showOffline(true);
    stopEtaRefresh();
    startOfflineCountdown();
}

function goOnline() {
    offlineMode = false;
    showOffline(false);
    clearInterval(offlineCountdownInterval);
    if (destLat && destLng) startEtaRefresh();
}

function startOfflineCountdown() {
    if (!currentDurationMin) return;
    let remaining = currentDurationMin;
    clearInterval(offlineCountdownInterval);

    offlineCountdownInterval = setInterval(() => {
        if (!offlineMode) { clearInterval(offlineCountdownInterval); return; }
        remaining = Math.max(0, remaining - (5 / 60));
        const mins = Math.round(remaining);
        const timeStr = mins >= 60
            ? `${Math.floor(mins / 60)}h ${mins % 60}min (est.)`
            : `${mins} min (est.)`;
        ["time-value", "mobile-time-value"].forEach(id => {
            const elem = document.getElementById(id);
            if (elem) elem.textContent = timeStr;
        });
        applyTrafficColor(remaining);
        if (alarmSet) checkAlarmTrigger(remaining);
    }, 5000);
}

// ── Haversine ─────────────────────────────────────────────────
function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Leaflet Initialization ─────────────────────────────────────
function initMap(mapId, isMobile) {
    const mapInstance = L.map(mapId, { zoomControl: false }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(mapInstance);

    if (isMobile) mobileMap = mapInstance;
    else          map       = mapInstance;

    el(isMobile ? "mobile-map-placeholder" : "map-placeholder").classList.add("hidden");
    el(mapId).classList.remove("hidden");
    setTimeout(() => mapInstance.invalidateSize(), 100);
    return mapInstance;
}

function updateMarkers(lat, lng) {
    if (!map) initMap("map", false);
    if (!userMarker) {
        const icon = L.divIcon({ className: 'user-marker', iconSize: [16, 16] });
        userMarker = L.marker([lat, lng], { icon }).addTo(map);
        map.setView([lat, lng], 16);
    } else {
        userMarker.setLatLng([lat, lng]);
    }

    if (!mobileMap) initMap("mobile-map", true);
    if (!mobileUserMarker) {
        const icon = L.divIcon({ className: 'user-marker', iconSize: [16, 16] });
        mobileUserMarker = L.marker([lat, lng], { icon }).addTo(mobileMap);
        mobileMap.setView([lat, lng], 16);
    } else {
        mobileUserMarker.setLatLng([lat, lng]);
    }
}

function recenterMap() {
    if (!currentLat || !currentLng) return;
    if (map)       map.setView([currentLat, currentLng], 16);
    if (mobileMap) mobileMap.setView([currentLat, currentLng], 16);
}

// ── GPS Tracking ───────────────────────────────────────────────
function startTracking() {
    if (!navigator.geolocation) {
        updateStatus("❌ Geolocation not supported");
        setGpsDot("error");
        return;
    }
    navigator.geolocation.watchPosition(onLocationUpdate, onLocationError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });

    if (checkIntervalId) clearInterval(checkIntervalId);
    checkIntervalId = setInterval(async () => {
        if (currentLat && currentLng) await checkRailways();
    }, CHECK_INTERVAL_MS);
}

async function onLocationUpdate(position) {
    const rawLat = position.coords.latitude;
    const rawLng = position.coords.longitude;
    currentLat = latFilter.filter(rawLat);
    currentLng = lngFilter.filter(rawLng);
    const accuracy = Math.round(position.coords.accuracy);

    updateStatus(`📍 ${currentLat.toFixed(5)}, ${currentLng.toFixed(5)} | ±${accuracy}m`);
    setGpsDot("found");
    updateMarkers(currentLat, currentLng);

    if (destLat && destLng) {
        motionTracker.addPosition(currentLat, currentLng);
        updateMotionUI();
    }

    if (destLat && destLng) {
        if (lastRouteLat === null ||
            distanceM(lastRouteLat, lastRouteLng, currentLat, currentLng) >= ROUTE_MIN_MOVE_M) {
            lastRouteLat = currentLat;
            lastRouteLng = currentLng;
            await updateRoute();
        }
    }
}

function onLocationError(err) {
    console.warn("GPS:", err.message);
    updateStatus("⚠️ Using best available location");
    setGpsDot("error");
}

// ── Check Railways ─────────────────────────────────────────────
async function checkRailways() {
    if (!currentLat || !currentLng) return;
    try {
        const res  = await fetch("/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat: currentLat, lng: currentLng })
        });
        const data = await res.json();

        if (data.found) {
            consecutiveTrainDetections++;
            if (consecutiveTrainDetections >= 5) {
                showTrainAlert("You have been detected near railway tracks 5 times in a row. You might be travelling by train!");
                consecutiveTrainDetections = 0;
            }
        } else {
            consecutiveTrainDetections = 0;
        }
        updateDetectionUI(data);
    } catch (e) { console.error("Check error:", e); }
}

function updateDetectionUI(data) {
    const configs = [
        { panel: "detection-panel", badge: "result-badge", details: "result-details", closest: "closest-box" },
        { panel: "mobile-detection-panel", badge: "mobile-result-badge", details: "mobile-result-details", closest: "mobile-closest-box" }
    ];

    configs.forEach(c => {
        const panel = el(c.panel);
        if (!panel) return;
        panel.classList.remove("hidden");

        if (data.found) {
            if (!trainDetectedLastTime) {
                speak("Warning: Train infrastructure detected nearby.");
                trainDetectedLastTime = true;
            }
            el(c.badge).innerHTML = `<div class="result-yes">✅ Train infrastructure found within 400m!</div>`;
            let html = `<p style="font-weight:600;font-size:0.85rem;margin-bottom:6px">Total: ${data.total} | Detections: ${consecutiveTrainDetections}/5</p>`;
            if (data.tracks.length > 0) {
                html += `<p style="font-weight:600;font-size:0.83rem;margin:6px 0 3px">🛤️ Lines: ${data.tracks.length}</p>`;
                data.tracks.forEach(t => { html += `<div class="railway-item">- ${t.type} → ${t.distance}m</div>`; });
            }
            if (data.stations.length > 0) {
                html += `<p style="font-weight:600;font-size:0.83rem;margin:6px 0 3px">🚉 Stations: ${data.stations.length}</p>`;
                data.stations.forEach(s => { html += `<div class="railway-item">- ${s.type} → ${s.distance}m</div>`; });
            }
            el(c.details).innerHTML = html;
            if (data.closest) {
                el(c.closest).innerHTML = `
                    <div class="closest-box">
                        <div class="closest-distance">${data.closest.distance}m</div>
                        <div class="closest-type">Closest: ${data.closest.type}</div>
                    </div>`;
            }
        } else {
            trainDetectedLastTime = false;
            el(c.badge).innerHTML = `<div class="result-no">❌ No train tracks within 400m</div>`;
            el(c.details).innerHTML = "";
            el(c.closest).innerHTML = "";
        }
    });
}

// ── Update Route ───────────────────────────────────────────────
async function updateRoute() {
    if (!currentLat || !currentLng || !destLat || !destLng) return;
    showLoadingBar(true);
    try {
        const res  = await fetch("/directions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                orig_lat: currentLat, orig_lng: currentLng,
                dest_lat: destLat,    dest_lng: destLng
            })
        });
        const data = await res.json();
        if (!data.error) {
            updateRouteUI(data.distance_km, data.time_str, data.duration_min);
            if (data.geometry) updateMapRoute(data.geometry);
        }
    } catch (e) { console.error("Route error:", e); }
    finally { showLoadingBar(false); }
}

function updateRouteUI(distanceKm, timeStr, durationMin) {
    currentDurationMin = durationMin;
    const cleanTimeStr = sanitizeTimeText(timeStr);
    ["time-value",     "mobile-time-value"].forEach(id => { if (el(id)) el(id).textContent = cleanTimeStr; });
    applyTrafficColor(durationMin);
    ["distance-value", "mobile-distance-value"].forEach(id => { if (el(id)) el(id).textContent = `(${distanceKm} km)`; });
    ["route-panel",    "mobile-route-panel"].forEach(id => { if (el(id)) el(id).classList.remove("hidden"); });
    updateAlarmMax(durationMin);
    if (alarmSet) checkAlarmTrigger(durationMin);
}

// ── Live ETA Refresh ───────────────────────────────────────────
function startEtaRefresh() {
    stopEtaRefresh();
    etaRefreshInterval = setInterval(async () => {
        if (!destLat || !destLng || !currentLat || !currentLng || offlineMode) return;
        try {
            const res  = await fetch("/directions", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({
                    orig_lat: currentLat, orig_lng: currentLng,
                    dest_lat: destLat,    dest_lng: destLng
                })
            });
            const data = await res.json();
            if (!data.error) {
                updateRouteUI(data.distance_km, data.time_str, data.duration_min);
                if (data.geometry) updateMapRoute(data.geometry);
                console.log(`[ETA Refresh] ${data.time_str} | ${data.distance_km} km`);
            }
        } catch (e) {
            console.warn("[ETA Refresh] skipped:", e.message);
        }
    }, ETA_REFRESH_MS);
}

function stopEtaRefresh() {
    if (etaRefreshInterval) {
        clearInterval(etaRefreshInterval);
        etaRefreshInterval = null;
    }
}
