from flask import Flask, request, jsonify, render_template
from supabase import create_client
import requests
import math
import os
import json
import time
from datetime import datetime, timezone, timedelta
from collections import defaultdict

app = Flask(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yiuyqrmnvifjlqwbylrb.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpdXlxcm1udmlmamxxd2J5bHJiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNjMxOSwiZXhwIjoyMDk0MzAyMzE5fQ.1h-6egdeQHoLtub1E_o8Il1zi8-aDrxoYcqJ-nOsWJE")
MAPMYINDIA_API_KEY   = "5780541cd5170c7f05c434332d0f624c"
MMI_CLIENT_ID        = os.environ.get("MMI_CLIENT_ID",     "96dHZVzsAusUnCwOVh6xKGzE2NxQKkhAEyZcW-HWCeRvk4ocRc_fAWJlODOfjHQI7a8hMx1BwGNf3bp0jtX4zA==")
MMI_CLIENT_SECRET    = os.environ.get("MMI_CLIENT_SECRET", "lrFxI-iSEg-Seu7m5QnUSKeeT26b4KY5hlwT-ZefxVquzLB_rT7sXujqE5FvCmyY_wOaBlMrkecQBQCSRJVTyWKqBJ7gCwzA")
OLA_MAPS_API_KEY     = os.environ.get("OLA_MAPS_API_KEY", "TaF8ZPfiZp2Z1UQbX5XEnWCBqDu3EbzBQaMWzBoR")

SEARCH_RADIUS_M = 400

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8636360519:AAFbTBdM2ZfDqmN5FyCttn3s5MZVcZ4RkGg")
TELEGRAM_API_BASE  = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

_sos_pending: dict = {}

if not all([SUPABASE_URL, SUPABASE_KEY]):
    raise ValueError("Missing required environment variables: SUPABASE_URL or SUPABASE_KEY")

# ── MapMyIndia OAuth2 token cache ──────────────────────────────
_mmi_token        = None
_mmi_token_expiry = 0

def get_mmi_token() -> str | None:
    global _mmi_token, _mmi_token_expiry
    if "PASTE_YOUR" in MMI_CLIENT_ID or "PASTE_YOUR" in MMI_CLIENT_SECRET:
        return None
    if _mmi_token and time.time() < _mmi_token_expiry:
        return _mmi_token
    try:
        resp = requests.post(
            "https://outpost.mappls.com/api/security/oauth/token",
            data={
                "grant_type":    "client_credentials",
                "client_id":     MMI_CLIENT_ID,
                "client_secret": MMI_CLIENT_SECRET,
            },
            timeout=8
        )
        if resp.status_code == 200:
            data = resp.json()
            _mmi_token        = data.get("access_token")
            expires_in        = int(data.get("expires_in", 21600))
            _mmi_token_expiry = time.time() + expires_in - 60
            print(f"MMI token obtained, expires in {expires_in}s")
            return _mmi_token
        else:
            print(f"MMI token error: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"MMI token fetch failed: {e}")
    return None

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

user_sessions          = {}
train_detection_counts = {}
TRAIN_DETECTION_THRESHOLD = 5


# ════════════════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════════════════

def validate_coordinates(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
        if not -90  <= lat <= 90:  return False, "Latitude must be between -90 and 90"
        if not -180 <= lon <= 180: return False, "Longitude must be between -180 and 180"
        return True, None
    except (TypeError, ValueError):
        return False, "Coordinates must be numeric values"


def haversine(lat1, lon1, lat2, lon2):
    try:
        R = 6371000
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi    = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    except Exception as e:
        print(f"Haversine error: {e}"); raise


def decode_polyline(encoded: str) -> list:
    coords = []
    index = lat = lng = 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift  += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lng:
                lng += delta
            else:
                lat += delta
        coords.append([lng / 1e5, lat / 1e5])
    return coords


# ════════════════════════════════════════════════════════════════
#  SEARCH & AUTOCOMPLETE
# ════════════════════════════════════════════════════════════════
def get_suggestions(query: str, user_lat: float = None, user_lng: float = None) -> list:
    suggestions = []
    seen_labels = set()

    def _append(label, lat, lng, icon, source):
        if label and label not in seen_labels and (lat != 0 or lng != 0):
            suggestions.append({"label": label, "lat": lat, "lng": lng,
                                 "icon": icon, "source": source})
            seen_labels.add(label)

    # 0. Ola Maps Autocomplete
    try:
        url = f"https://api.olamaps.io/places/v1/autocomplete?input={query}&api_key={OLA_MAPS_API_KEY}"
        resp = requests.get(url, timeout=6)
        if resp.status_code == 200:
            for p in resp.json().get("predictions", []):
                label = p.get("description", "")
                loc = p.get("geometry", {}).get("location", {})
                lat = float(loc.get("lat") or 0)
                lng = float(loc.get("lng") or 0)
                is_train = "railway" in p.get("types", []) or "station" in p.get("types", [])
                _append(label, lat, lng, "train" if is_train else "place", "olamaps")
    except Exception as e:
        print(f"Ola Maps Autocomplete error: {e}")

    # 1. MapMyIndia Atlas Search
    token = get_mmi_token()
    if token:
        try:
            params = {"query": query, "region": "IND"}
            if user_lat and user_lng:
                params["location"] = f"{user_lat},{user_lng}"
            resp = requests.get(
                "https://atlas.mappls.com/api/places/search/json",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
                timeout=6
            )
            if resp.status_code == 200:
                for p in resp.json().get("suggestedLocations", []):
                    name    = p.get("placeName", "")
                    addr    = p.get("placeAddress", "")
                    label   = f"{name}, {addr}" if addr else name
                    lat     = float(p.get("latitude")  or p.get("lat")  or 0)
                    lng     = float(p.get("longitude") or p.get("lng")  or 0)
                    cat     = p.get("type", "").lower()
                    is_train = "railway" in cat or "station" in cat
                    _append(label, lat, lng, "train" if is_train else "place", "mapmyindia")
        except Exception as e:
            print(f"MMI Atlas Search error: {e}")

    # 2. Photon fallback
    if not suggestions:
        try:
            params = {"q": query, "limit": 8, "lang": "en"}
            if user_lat and user_lng:
                params["lat"] = user_lat
                params["lon"] = user_lng
            else:
                params["bbox"] = "68.1,8.0,97.4,37.1"
            resp = requests.get(
                "https://photon.komoot.io/api/",
                params=params,
                headers={"User-Agent": "YatraAlart/1.3 travel-alarm-app"},
                timeout=6
            )
            if resp.status_code == 200:
                for f in resp.json().get("features", []):
                    props  = f.get("properties", {})
                    coords = f.get("geometry", {}).get("coordinates", [])
                    if len(coords) < 2:
                        continue
                    lng, lat = float(coords[0]), float(coords[1])
                    parts = [props.get("name", "")]
                    if props.get("district"): parts.append(props["district"])
                    if props.get("state"):    parts.append(props["state"])
                    if props.get("country"):  parts.append(props["country"])
                    label    = ", ".join(p for p in parts if p)
                    osm_key  = props.get("osm_key", "")
                    osm_val  = props.get("osm_value", "")
                    is_train = osm_key == "railway" or osm_val in ("station", "halt", "stop", "tram_stop")
                    _append(label, lat, lng, "train" if is_train else "place", "photon")
        except Exception as e:
            print(f"Photon suggestions error: {e}")

    # 3. Nominatim fallback
    if not suggestions:
        try:
            params = {"q": query + ", India", "format": "json",
                      "limit": 8, "countrycodes": "in", "addressdetails": "0"}
            if user_lat and user_lng:
                delta = 2.7
                params["viewbox"] = f"{user_lng-delta},{user_lat+delta},{user_lng+delta},{user_lat-delta}"
                params["bounded"] = "0"
            resp = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers={"User-Agent": "YatraAlart/1.3 travel-alarm-app"},
                timeout=8
            )
            if resp.status_code == 200:
                for r in resp.json():
                    label    = r.get("display_name", "")
                    is_train = r.get("class", "") == "railway"
                    _append(label, float(r["lat"]), float(r["lon"]),
                            "train" if is_train else "place", "nominatim")
        except Exception as e:
            print(f"Nominatim suggestions error: {e}")

    return suggestions


# ════════════════════════════════════════════════════════════════
#  GEOCODING
# ════════════════════════════════════════════════════════════════
def get_geocode(query: str) -> dict:
    try:
        if not query or len(query.strip()) < 1:
            raise ValueError("Query cannot be empty")
        query = query.strip()

        try:
            url = f"https://api.olamaps.io/places/v1/geocode?address={query}&api_key={OLA_MAPS_API_KEY}"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                results = resp.json().get("geocodingResults", [])
                if results:
                    r = results[0]
                    loc = r.get("geometry", {}).get("location", {})
                    lat = float(loc.get("lat") or 0)
                    lng = float(loc.get("lng") or 0)
                    is_valid, _ = validate_coordinates(lat, lng)
                    if is_valid and (lat != 0 or lng != 0):
                        return {
                            "label": r.get("formatted_address", query),
                            "lat": lat, "lng": lng, "source": "olamaps"
                        }
        except Exception as e:
            print(f"Ola Maps Geocode error: {e}")

        try:
            url = "https://atlas.mappls.com/api/places/geocode"
            params = {"address": query, "access_token": MAPMYINDIA_API_KEY}
            resp = requests.get(url, params=params, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("copResults", [])
                if results:
                    r = results[0]
                    lat = float(r.get("latitude") or r.get("lat") or 0)
                    lng = float(r.get("longitude") or r.get("lng") or 0)
                    is_valid, err = validate_coordinates(lat, lng)
                    if is_valid and (lat != 0 or lng != 0):
                        return {
                            "label": r.get("formattedAddress", query),
                            "lat": lat, "lng": lng, "source": "mapmyindia"
                        }
        except Exception as e:
            print(f"MMI Geocode error: {e}")

        url = "https://nominatim.openstreetmap.org/search"
        params = {"q": query + ", India", "format": "json",
                  "limit": 1, "countrycodes": "in"}
        headers = {"User-Agent": "YatraAlart/1.0"}
        resp = requests.get(url, params=params, headers=headers, timeout=5)
        data = resp.json()
        if data:
            r = data[0]
            lat = float(r["lat"])
            lng = float(r["lon"])
            is_valid, err = validate_coordinates(lat, lng)
            if is_valid:
                return {
                    "label": r.get("display_name", query),
                    "lat": lat, "lng": lng, "source": "nominatim"
                }

        raise ValueError("Location not found")

    except Exception as e:
        print(f"Geocode error: {e}")
        raise ValueError(str(e))


# ════════════════════════════════════════════════════════════════
#  DIRECTIONS
# ════════════════════════════════════════════════════════════════
def get_directions(orig_lat, orig_lng, dest_lat, dest_lng) -> dict:
    try:
        for lat, lng in [(orig_lat, orig_lng), (dest_lat, dest_lng)]:
            ok, err = validate_coordinates(lat, lng)
            if not ok:
                raise ValueError(f"Invalid coordinate: {err}")

        try:
            url = f"https://api.olamaps.io/routing/v1/directions?origin={orig_lat},{orig_lng}&destination={dest_lat},{dest_lng}&api_key={OLA_MAPS_API_KEY}"
            resp = requests.post(url, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("routes"):
                    route = data["routes"][0]
                    leg = route.get("legs", [{}])[0]
                    distance_m = leg.get("distance", 0)
                    duration_sec = leg.get("duration", 0)
                    distance_km = round(distance_m / 1000, 1)
                    duration_min = round(duration_sec / 60)
                    time_val = (f"{duration_min // 60}h {duration_min % 60}min"
                                if duration_min >= 60 else f"{duration_min} min")
                    polyline = route.get("overview_polyline", "")
                    geometry = {"type": "LineString", "coordinates": decode_polyline(polyline)} if polyline else None
                    return {
                        "distance_km": distance_km,
                        "time_str": f"{time_val} (Ola Maps)",
                        "duration_min": duration_min,
                        "geometry": geometry,
                        "source": "olamaps"
                    }
        except Exception as e:
            print(f"Ola Maps Directions error: {e}")

        try:
            url = f"https://apis.mapmyindia.com/advancedmaps/v1/{MAPMYINDIA_API_KEY}/route_adv/driving/{orig_lng},{orig_lat};{dest_lng},{dest_lat}"
            params = {"steps": "true", "overview": "full", "geometries": "geojson"}
            resp = requests.get(url, params=params, timeout=10)

            if resp.status_code == 200:
                data = resp.json()
                if data.get("routes"):
                    route        = data["routes"][0]
                    distance_m   = route.get("distance", 0)
                    duration_sec = route.get("duration", 0)
                    distance_km  = round(distance_m / 1000, 1)
                    duration_min = round(duration_sec / 60)
                    time_val     = (f"{duration_min // 60}h {duration_min % 60}min"
                                    if duration_min >= 60 else f"{duration_min} min")
                    return {
                        "distance_km": distance_km,
                        "time_str":    f"{time_val} (incl. traffic)",
                        "duration_min": duration_min,
                        "geometry":    route.get("geometry"),
                        "source":      "mapmyindia"
                    }
        except Exception as e:
            print(f"MMI Directions error: {e}")

        url = (f"http://router.project-osrm.org/route/v1/driving/"
               f"{orig_lng},{orig_lat};{dest_lng},{dest_lat}")
        params = {"overview": "full", "geometries": "geojson"}
        resp = requests.get(url, params=params, timeout=10)
        data = resp.json()

        if data.get("code") == "Ok" and data.get("routes"):
            route        = data["routes"][0]
            distance_m   = route["distance"]
            duration_sec = route["duration"]
            distance_km  = round(distance_m / 1000, 1)
            duration_min = round(duration_sec / 60)
            time_val     = (f"{duration_min // 60}h {duration_min % 60}min"
                            if duration_min >= 60 else f"{duration_min} min")
            return {
                "distance_km": distance_km,
                "time_str":    f"{time_val} (no traffic)",
                "duration_min": duration_min,
                "geometry":    route.get("geometry"),
                "source":      "osrm"
            }

        raise ValueError("No route found")

    except Exception as e:
        print(f"Directions error: {e}"); raise


# ════════════════════════════════════════════════════════════════
#  RAILWAY DETECTION
# ════════════════════════════════════════════════════════════════
def check_railway_nearby(lat, lng):
    ok, err = validate_coordinates(lat, lng)
    if not ok:
        raise ValueError(err)

    lat, lng = float(lat), float(lng)
    lat_margin, lng_margin = 0.004, 0.005
    nearby = []

    try:
        points = supabase.table("railways")\
            .select("railway_type, geometry_type, lat, lon")\
            .eq("geometry_type", "Point")\
            .gte("lat", lat - lat_margin).lte("lat", lat + lat_margin)\
            .gte("lon", lng - lng_margin).lte("lon", lng + lng_margin)\
            .execute()
        for row in points.data:
            try:
                dist = haversine(lat, lng, row["lat"], row["lon"])
                if dist <= SEARCH_RADIUS_M:
                    nearby.append({"type": row["railway_type"],
                                   "geometry": "Point",
                                   "distance": round(dist)})
            except Exception as e:
                print(f"Point error: {e}")
    except Exception as e:
        print(f"Points query error: {e}")

    try:
        lines = supabase.table("railways")\
            .select("railway_type, geometry_type, lat, lon, "
                    "min_lat, max_lat, min_lon, max_lon, coordinates")\
            .eq("geometry_type", "LineString")\
            .lte("min_lat", lat + lat_margin).gte("max_lat", lat - lat_margin)\
            .lte("min_lon", lng + lng_margin).gte("max_lon", lng - lng_margin)\
            .execute()
        for row in lines.data:
            try:
                coords  = (json.loads(row["coordinates"])
                           if isinstance(row["coordinates"], str)
                           else row["coordinates"])
                min_dist = min(haversine(lat, lng, c[1], c[0]) for c in coords)
                if min_dist <= SEARCH_RADIUS_M:
                    nearby.append({"type": row["railway_type"],
                                   "geometry": "LineString",
                                   "distance": round(min_dist)})
            except Exception as e:
                print(f"Line error: {e}")
    except Exception as e:
        print(f"Lines query error: {e}")

    return nearby


# ════════════════════════════════════════════════════════════════
#  FLASK ROUTES
# ════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    try:
        return render_template("index.html")
    except Exception as e:
        print(f"Index error: {e}"); return "Error loading page", 500


@app.route("/check", methods=["POST"])
def check():
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400
        data = request.json
        if "lat" not in data or "lng" not in data:
            return jsonify({"error": "Missing lat, lng"}), 400
        try:
            lat, lng = float(data["lat"]), float(data["lng"])
        except (TypeError, ValueError):
            return jsonify({"error": "Coordinates must be numeric"}), 400
        ok, err = validate_coordinates(lat, lng)
        if not ok:
            return jsonify({"error": err}), 400
        nearby   = check_railway_nearby(lat, lng)
        tracks   = [n for n in nearby if n["geometry"] == "LineString"]
        stations = [n for n in nearby if n["geometry"] == "Point"]
        closest  = min(nearby, key=lambda x: x["distance"]) if nearby else None
        return jsonify({"found": bool(nearby), "total": len(nearby),
                        "tracks": tracks[:5], "stations": stations[:5],
                        "closest": closest})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(f"Check error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/directions", methods=["POST"])
def directions():
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400
        data   = request.json
        fields = ["orig_lat", "orig_lng", "dest_lat", "dest_lng"]
        if not all(f in data for f in fields):
            return jsonify({"error": f"Missing fields: {', '.join(fields)}"}), 400
        try:
            result = get_directions(float(data["orig_lat"]), float(data["orig_lng"]),
                                    float(data["dest_lat"]), float(data["dest_lng"]))
            return jsonify(result)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(f"Directions error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/suggestions", methods=["GET"])
def suggestions():
    try:
        query = request.args.get("q", "").strip()
        if len(query) < 2:
            return jsonify([])
        try:
            user_lat = float(request.args.get("lat", ""))
            user_lng = float(request.args.get("lng", ""))
        except (TypeError, ValueError):
            user_lat = user_lng = None
        return jsonify(get_suggestions(query, user_lat, user_lng))
    except Exception as e:
        print(f"Suggestions error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/geocode", methods=["GET"])
def geocode():
    try:
        query = request.args.get("q", "").strip()
        if not query:
            return jsonify({"error": "No query provided"}), 400
        try:
            return jsonify(get_geocode(query))
        except ValueError as e:
            return jsonify({"error": str(e)}), 404
    except Exception as e:
        print(f"Geocode error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/track/start", methods=["POST"])
def track_start():
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400
        data = request.json
        if not all(k in data for k in ["lat", "lng", "user_id"]):
            return jsonify({"error": "Missing lat, lng, user_id"}), 400
        lat, lng, user_id = float(data["lat"]), float(data["lng"]), str(data["user_id"])
        ok, err = validate_coordinates(lat, lng)
        if not ok:
            return jsonify({"error": err}), 400
        user_sessions[user_id]          = {"source": (lat, lng), "last_location": (lat, lng), "updated_at": datetime.now()}
        train_detection_counts[user_id] = 0
        return jsonify({"status": "success", "message": "Tracking started",
                        "source": {"lat": lat, "lng": lng}, "user_id": user_id})
    except Exception as e:
        print(f"Track start error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/track/update", methods=["POST"])
def track_update():
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400
        data = request.json
        if not all(k in data for k in ["lat", "lng", "user_id"]):
            return jsonify({"error": "Missing lat, lng, user_id"}), 400
        lat, lng, user_id = float(data["lat"]), float(data["lng"]), str(data["user_id"])
        ok, err = validate_coordinates(lat, lng)
        if not ok:
            return jsonify({"error": err}), 400

        if user_id not in user_sessions:
            user_sessions[user_id]          = {"source": (lat, lng), "last_location": (lat, lng), "updated_at": datetime.now()}
            train_detection_counts[user_id] = 0

        prev    = user_sessions[user_id]["last_location"]
        source  = user_sessions[user_id]["source"]
        user_sessions[user_id]["last_location"] = (lat, lng)
        user_sessions[user_id]["updated_at"]    = datetime.now()

        d_source = haversine(source[0], source[1], lat, lng)
        d_prev   = haversine(prev[0],   prev[1],   lat, lng)

        nearby = check_railway_nearby(lat, lng)
        found  = bool(nearby)

        if found:
            train_detection_counts[user_id] += 1
        else:
            train_detection_counts[user_id]  = 0

        train_alert   = False
        alert_message = None
        if train_detection_counts[user_id] >= TRAIN_DETECTION_THRESHOLD:
            train_alert   = True
            alert_message = (f"🚂 TRAIN DETECTED! Near railway tracks "
                             f"{train_detection_counts[user_id]} times in a row. "
                             f"You might be travelling by train!")
            train_detection_counts[user_id] = 0

        tracks   = [n for n in nearby if n["geometry"] == "LineString"]
        stations = [n for n in nearby if n["geometry"] == "Point"]
        closest  = min(nearby, key=lambda x: x["distance"]) if nearby else None

        try:
            current_route = get_directions(source[0], source[1], lat, lng)
        except:
            current_route = None

        return jsonify({
            "status": "success", "user_id": user_id,
            "current_location":       {"lat": lat,      "lng": lng},
            "source":                 {"lat": source[0], "lng": source[1]},
            "distance_from_source_m": round(d_source),
            "distance_from_prev_m":   round(d_prev),
            "current_route":          current_route,
            "railway_detection": {
                "found": found, "total_nearby": len(nearby),
                "tracks": tracks[:5], "stations": stations[:5],
                "closest": closest,
                "consecutive_detections": train_detection_counts[user_id]
            },
            "train_alert": train_alert, "alert_message": alert_message
        })
    except Exception as e:
        print(f"Track update error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/track/stop", methods=["POST"])
def track_stop():
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400
        user_id = str(request.json.get("user_id", ""))
        if not user_id or user_id not in user_sessions:
            return jsonify({"error": "No active session"}), 404
        session  = user_sessions[user_id]
        source   = session["source"]
        last_loc = session["last_location"]
        total    = haversine(source[0], source[1], last_loc[0], last_loc[1])
        try:
            trip_info = get_directions(source[0], source[1], last_loc[0], last_loc[1])
        except:
            trip_info = None
        del user_sessions[user_id]
        del train_detection_counts[user_id]
        return jsonify({"status": "success", "message": "Tracking stopped",
                        "trip_summary": {
                            "source":      {"lat": source[0],   "lng": source[1]},
                            "destination": {"lat": last_loc[0], "lng": last_loc[1]},
                            "distance_m":  round(total),
                            "trip_info":   trip_info
                        }})
    except Exception as e:
        print(f"Track stop error: {e}"); return jsonify({"error": "Internal server error"}), 500


@app.route("/track/session/<user_id>", methods=["GET"])
def track_session(user_id):
    try:
        user_id = str(user_id)
        if user_id not in user_sessions:
            return jsonify({"error": "No active session"}), 404
        session  = user_sessions[user_id]
        source   = session["source"]
        last_loc = session["last_location"]
        dist     = haversine(source[0], source[1], last_loc[0], last_loc[1])
        return jsonify({
            "status": "active", "user_id": user_id,
            "source":           {"lat": source[0],   "lng": source[1]},
            "current_location": {"lat": last_loc[0], "lng": last_loc[1]},
            "distance_m":       round(dist),
            "consecutive_train_detections": train_detection_counts.get(user_id, 0),
            "updated_at":       session["updated_at"].isoformat()
        })
    except Exception as e:
        print(f"Session error: {e}"); return jsonify({"error": "Internal server error"}), 500


# ════════════════════════════════════════════════════════════════
#  TELEGRAM SOS ROUTES
# ════════════════════════════════════════════════════════════════

@app.route("/sos/webhook", methods=["POST"])
def sos_webhook():
    try:
        update  = request.json or {}
        message = update.get("message", {})
        chat    = message.get("chat", {})
        text    = message.get("text", "").strip()
        chat_id = chat.get("id")

        if not chat_id:
            return jsonify({"ok": True})

        if text.startswith("/start"):
            import random
            code = str(random.randint(10000, 99999))
            _sos_pending[code] = chat_id

            reply_text = (
                f"✅ *YatraAlart SOS linked!*\n\n"
                f"Your verification code is:\n\n"
                f"🔑 *{code}*\n\n"
                f"Share this code with the person who needs to reach you in an emergency. "
                f"They will enter it in the YatraAlart app."
            )
            requests.post(
                f"{TELEGRAM_API_BASE}/sendMessage",
                json={"chat_id": chat_id, "text": reply_text, "parse_mode": "Markdown"},
                timeout=8
            )
            print(f"SOS webhook: code {code} → chat_id {chat_id}")

        return jsonify({"ok": True})
    except Exception as e:
        print(f"SOS webhook error: {e}")
        return jsonify({"ok": True})


@app.route("/sos/verify", methods=["GET"])
def sos_verify():
    try:
        code = request.args.get("code", "").strip()
        if not code:
            return jsonify({"error": "No code provided"}), 400

        chat_id = _sos_pending.get(code)
        if not chat_id:
            return jsonify({"error": "Invalid or expired code. Ask your contact to press Start again."}), 404

        del _sos_pending[code]
        print(f"SOS verify: code {code} → chat_id {chat_id} verified")
        return jsonify({"chat_id": chat_id})
    except Exception as e:
        print(f"SOS verify error: {e}")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/sos/send", methods=["POST"])
def sos_send():
    """
    Accepts:
      { lat, lng, chat_ids: [id1, id2, ...], custom_message: str, update_number: int }
    Also accepts single chat_id for backward compatibility.
    Sends Telegram message to ALL chat_ids in parallel.
    """
    try:
        if not request.json:
            return jsonify({"error": "JSON body required"}), 400

        data           = request.json
        lat            = data.get("lat")
        lng            = data.get("lng")
        chat_ids       = data.get("chat_ids", [])
        custom_message = data.get("custom_message", "I need help! Please call me immediately.")
        update_number  = int(data.get("update_number", 1))

        # Backward compatibility — accept single chat_id
        single = data.get("chat_id")
        if single and not chat_ids:
            chat_ids = [str(single)]

        if not lat or not lng or not chat_ids:
            return jsonify({"error": "Missing lat, lng, or chat_ids"}), 400

        ok, err = validate_coordinates(lat, lng)
        if not ok:
            return jsonify({"error": err}), 400

        # IST timestamp
        ist      = timezone(timedelta(hours=5, minutes=30))
        now_ist  = datetime.now(ist)
        time_str = now_ist.strftime("%I:%M %p IST")

        maps_link = f"https://maps.google.com/?q={lat},{lng}"
        message   = (
            f"🚨 {custom_message}\n\n"
            f"📍 Live Location:\n{maps_link}\n\n"
            f"🕐 {time_str}\n"
            f"📌 Update #{update_number} — sent by YatraAlart"
        )

        results = []
        for chat_id in chat_ids:
            try:
                resp = requests.post(
                    f"{TELEGRAM_API_BASE}/sendMessage",
                    json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"},
                    timeout=10
                )
                success = resp.status_code == 200
                results.append({"chat_id": chat_id, "ok": success})
                print(f"SOS → chat_id {chat_id}: HTTP {resp.status_code}")
            except Exception as e:
                print(f"SOS send error for chat_id {chat_id}: {e}")
                results.append({"chat_id": chat_id, "ok": False})

        sent_count = sum(1 for r in results if r["ok"])
        return jsonify({
            "status":  "sent",
            "sent_to": sent_count,
            "total":   len(chat_ids)
        })

    except Exception as e:
        print(f"SOS send error: {e}")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/sw.js")
def service_worker():
    from flask import send_from_directory, make_response
    response = make_response(send_from_directory("static", "sw.js"))
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"]          = "no-cache, no-store, must-revalidate"
    response.headers["Content-Type"]           = "application/javascript"
    return response


@app.errorhandler(400)
def bad_request(e): return jsonify({"error": "Bad request"}), 400

@app.errorhandler(404)
def not_found(e): return jsonify({"error": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(e):
    print(f"Internal error: {e}"); return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    app.run(debug=True)
