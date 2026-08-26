"""
KūkiOS MCP Client - Main Client Module
"""

import os
import json
import time
import base64
from typing import Any, Dict, List
from urllib.parse import urlencode
import requests
from .exceptions import KukiOSAuthError, KukiOSAPIError, KukiOSConnectionError, KukiOSTimeoutError

_REDACTED = "***"


def _jwt_exp(token: str) -> float | None:
    """Return the `exp` claim from a JWT, or None if not parseable."""
    try:
        payload = token.split(".", 2)[1]
        # JWTs use base64url without padding.
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        exp = data.get("exp")
        return float(exp) if exp is not None else None
    except Exception:
        return None


# IAQ thresholds — mirrors kukios-mcp-server (IAQ_THRESHOLDS).
# Range-based params use (good, warning, critical) tuple ranges;
# scalar params use upper-bound thresholds.
IAQ_THRESHOLDS = {
    "temperature": {"good": (23, 26), "warning": (26, 28), "critical": (28, 35), "unit": "°C"},
    "humidity": {"good": (40, 60), "warning": (30, 70), "critical": (0, 100), "unit": "%"},
    "pm25": {"good": 15, "warning": 35, "critical": 55, "unit": "µg/m³"},
    "pm10": {"good": 45, "warning": 65, "critical": 100, "unit": "µg/m³"},
    "co2": {"good": 600, "warning": 800, "critical": 1000, "unit": "ppm"},
    "tvoc": {"good": 500, "warning": 1000, "critical": 2000, "unit": "µg/m³"},
    "formaldehyde": {"good": 80, "warning": 120, "critical": 200, "unit": "µg/m³"},
}

IAQ_RECOMMENDATIONS = {
    "temperature": "Adjust HVAC setpoints. Check zoning and solar gain.",
    "humidity": "Adjust HVAC dehumidification/humidification. Check for moisture sources.",
    "pm25": "Check/replace HVAC filters. Increase air filtration. Check for indoor sources (cooking, smoking).",
    "pm10": "Check HVAC filters. Reduce dust sources. Increase cleaning frequency.",
    "co2": "Increase ventilation. Open windows or increase fresh air intake. Check occupancy levels.",
    "tvoc": "Identify VOC source immediately. Check for new furniture, cleaning products, paint, or solvents. Increase ventilation.",
    "formaldehyde": "Check for formaldehyde sources (pressed wood, adhesives). Increase ventilation. Consider air purifier with activated carbon.",
}


class KukiOSClient:
    """
    KūkiOS MCP Client for connecting to KūkiOS IAQ Monitoring Platform.

    Features:
    - Auto authentication and token refresh
    - Connection pooling and retry logic
    - Error handling with custom exceptions
    - Type hints for all methods
    """

    def __init__(
        self,
        url: str = None,
        email: str = None,
        password: str = None,
        timeout: int = 30,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        """
        Initialize KūkiOS Client.

        Args:
            url: KūkiOS MCP server URL
            email: User email for authentication
            password: User password for authentication
            timeout: Request timeout in seconds
            max_retries: Maximum retry attempts
            retry_delay: Initial retry delay in seconds
        """
        # Env aliases: IAQ_* matches the kukios-mcp-server convention,
        # KUKIOS_* is kept for backwards compatibility.
        self.url = (
            url
            or os.getenv("IAQ_REPORTER_URL")
            or os.getenv("KUKIOS_URL")
            or "https://dashbeta.what-if.sg"
        )
        self.email = email or os.getenv("IAQ_EMAIL") or os.getenv("KUKIOS_EMAIL")
        self.password = password or os.getenv("IAQ_PASSWORD") or os.getenv("KUKIOS_PASSWORD")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay

        # Token management (IAQ_TOKEN / IAQ_REFRESH_TOKEN match mcp-server convention)
        self._token = os.getenv("IAQ_TOKEN") or None
        self._refresh_token = os.getenv("IAQ_REFRESH_TOKEN") or None
        self._token_expiry = None
        if self._token:
            exp = _jwt_exp(self._token)
            if exp is not None:
                self._token_expiry = exp

        # Session with connection pooling but no built-in retry —
        # the manual loop in _request handles retries so we don't double-retry.
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10,
            pool_maxsize=10,
        )
        self.session.mount('http://', adapter)
        self.session.mount('https://', adapter)

        # Auto-login if credentials provided
        if self.email and self.password:
            self.auth_login(self.email, self.password)

    def __enter__(self) -> "KukiOSClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self.session.close()

    def __repr__(self) -> str:
        return (
            f"KukiOSClient(url={self.url!r}, email={_REDACTED}, "
            f"password={_REDACTED})"
        )
    
    def _headers(self) -> Dict[str, str]:
        """Get request headers with authorization."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers
    
    def _check_token_expiry(self) -> bool:
        """Check if token needs refresh."""
        if self._token_expiry is None:
            return True
        # Refresh if token expires within 24 hours
        return time.time() > (self._token_expiry - 86400)

    def _store_tokens(self, access_token: str, refresh_token: str | None) -> None:
        """Persist a token pair and derive its expiry from the JWT `exp` claim."""
        self._token = access_token
        if refresh_token is not None:
            self._refresh_token = refresh_token
        # Prefer the server-issued expiry; fall back to 30d if missing/unparseable.
        exp = _jwt_exp(access_token)
        if exp is not None:
            self._token_expiry = exp
        else:
            self._token_expiry = time.time() + (30 * 24 * 60 * 60)

    def _auto_refresh_token(self) -> bool:
        """Attempt to refresh token using refresh token."""
        if not self._refresh_token:
            return False

        try:
            resp = self.session.post(
                f"{self.url}/api/auth/refresh",
                json={"refreshToken": self._refresh_token},
                headers={"Content-Type": "application/json"},
                timeout=self.timeout
            )
            if resp.status_code != 200:
                return False
            data = resp.json()
            if not (data.get("success") and data.get("tokens")):
                return False
            self._store_tokens(
                data["tokens"]["accessToken"],
                data["tokens"].get("refreshToken"),
            )
            return True
        except requests.RequestException:
            return False

    def _auto_reauthenticate(self) -> bool:
        """Full re-authentication using stored credentials."""
        if not self.email or not self.password:
            return False

        try:
            resp = self.session.post(
                f"{self.url}/api/auth/login",
                json={"email": self.email, "password": self.password},
                headers={"Content-Type": "application/json"},
                timeout=self.timeout
            )
            if resp.status_code != 200:
                return False
            data = resp.json()
            if not (data.get("success") and data.get("tokens")):
                return False
            self._store_tokens(
                data["tokens"]["accessToken"],
                data["tokens"].get("refreshToken"),
            )
            return True
        except requests.RequestException:
            return False

    def _check_and_refresh_token(self) -> bool:
        """Check if token needs refresh and attempt refresh."""
        if not self._check_token_expiry():
            return True

        # Try refresh token first, then full re-authentication.
        return self._auto_refresh_token() or self._auto_reauthenticate()

    def _send(self, method: str, url: str, json_data: dict = None) -> requests.Response:
        """Single HTTP attempt; no retries, no auth handling."""
        return self.session.request(
            method,
            url,
            headers=self._headers(),
            json=json_data,
            timeout=self.timeout,
        )

    def _request(self, method: str, path: str, json_data: dict = None) -> dict:
        """Make API request with retry and auto re-auth."""
        # Check token expiry before making request.
        self._check_and_refresh_token()

        url = f"{self.url}{path}"
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                resp = self._send(method, url, json_data)
            except requests.exceptions.Timeout:
                last_error = KukiOSTimeoutError(
                    f"Request timed out after {self.timeout}s"
                )
                self._sleep_backoff(attempt)
                continue
            except requests.exceptions.ConnectionError as e:
                last_error = KukiOSConnectionError(f"Connection failed: {self.url}: {e}")
                self._sleep_backoff(attempt)
                continue
            except requests.RequestException as e:
                # Other transport errors are not retryable.
                raise KukiOSConnectionError(f"Request failed: {e}")

            # Handle 401: try refresh, then re-auth, then retry once.
            if resp.status_code == 401:
                if self._auto_refresh_token() or self._auto_reauthenticate():
                    try:
                        resp = self._send(method, url, json_data)
                    except requests.RequestException:
                        raise last_error or KukiOSAPIError("Retry after auth failed")
                else:
                    raise KukiOSAuthError("Authentication failed")

            if 200 <= resp.status_code < 300:
                if resp.status_code == 204 or not resp.content:
                    return {}
                return resp.json()

            # 4xx other than 401: don't retry, surface immediately.
            if 400 <= resp.status_code < 500:
                if resp.status_code == 401:
                    raise KukiOSAuthError("Authentication failed")
                raise KukiOSAPIError(
                    f"API error: {resp.status_code}",
                    status_code=resp.status_code,
                    response=resp.text,
                )

            # 5xx: retryable.
            last_error = KukiOSAPIError(
                f"API error: {resp.status_code}",
                status_code=resp.status_code,
                response=resp.text,
            )
            self._sleep_backoff(attempt)

        # Exhausted retries.
        if last_error is not None:
            raise last_error
        raise KukiOSAPIError(f"Request failed after {self.max_retries} attempts")

    def _sleep_backoff(self, attempt: int) -> None:
        """Exponential backoff; no sleep on the final attempt."""
        if attempt >= self.max_retries - 1:
            return
        time.sleep(self.retry_delay * (2 ** attempt))

    def get(self, path: str, params: dict = None) -> dict:
        """GET request."""
        if params:
            path = f"{path}?{urlencode(params, doseq=True)}"
        return self._request("GET", path)

    def post(self, path: str, json_data: dict = None) -> dict:
        """POST request."""
        return self._request("POST", path, json_data)

    def put(self, path: str, json_data: dict = None) -> dict:
        """PUT request."""
        return self._request("PUT", path, json_data)

    def delete(self, path: str) -> dict:
        """DELETE request."""
        return self._request("DELETE", path)
    
    # ============================================================================
    # AUTHENTICATION
    # ============================================================================
    
    def auth_login(self, email: str, password: str) -> dict:
        """
        Authenticate and store credentials for auto re-auth.

        Args:
            email: User email
            password: User password

        Returns:
            Authentication response with tokens
        """
        data = self.post("/api/auth/login", {"email": email, "password": password})
        if data.get("success") and data.get("tokens"):
            self._store_tokens(
                data["tokens"]["accessToken"],
                data["tokens"].get("refreshToken"),
            )
            self.email = email
            self.password = password
        return data

    def auth_refresh(self, refresh_token: str) -> dict:
        """
        Refresh JWT token using refresh token.

        Args:
            refresh_token: Refresh token from login

        Returns:
            Refresh response with new tokens
        """
        data = self.post("/api/auth/refresh", {"refreshToken": refresh_token})
        if data.get("success") and data.get("tokens"):
            self._store_tokens(
                data["tokens"]["accessToken"],
                data["tokens"].get("refreshToken"),
            )
        return data
    
    def get_current_user(self) -> dict:
        """
        Get current user info.
        
        Returns:
            User object with id, email, firstName, lastName, role
        """
        return self.get("/api/auth/me")
    
    def get_token_status(self) -> dict:
        """
        Get current token status and expiry information.
        
        Returns:
            Token status with expiry time and auto-reauth capability
        """
        status = {
            "has_token": bool(self._token),
            "has_refresh_token": bool(self._refresh_token),
            "auto_reauth_enabled": bool(self.email and self.password),
            "token_expires": None
        }
        
        if self._token_expiry:
            remaining = self._token_expiry - time.time()
            status["token_expires"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self._token_expiry))
            status["remaining_seconds"] = int(remaining)
            status["remaining_days"] = round(remaining / 86400, 1)
            status["needs_refresh"] = self._check_token_expiry()
        
        return status
    
    # ============================================================================
    # BUILDINGS
    # ============================================================================
    
    def list_buildings(self, page: int = 0, page_size: int = 100) -> dict:
        """
        List all buildings.
        
        Args:
            page: Page number
            page_size: Items per page
            
        Returns:
            Buildings list
        """
        return self.get("/api/buildings", {"page": page, "page_size": page_size})
    
    def get_building(self, building_id: str) -> dict:
        """
        Get building details.
        
        Args:
            building_id: Building UUID
            
        Returns:
            Building object with levels
        """
        return self.get(f"/api/buildings/{building_id}")
    
    # ============================================================================
    # DEVICES
    # ============================================================================
    
    def list_devices(self) -> List[dict]:
        """
        List all devices.

        Returns:
            List of device objects. If the server returns a payload object
            with a `data` field, that field is unwrapped; otherwise the
            raw response is returned as a list.
        """
        data = self.get("/api/devices")
        return data if isinstance(data, list) else data.get("data", [])
    
    def get_device(self, device_id: str) -> dict:
        """
        Get device details.
        
        Args:
            device_id: Device UUID
            
        Returns:
            Device object
        """
        return self.get(f"/api/devices/{device_id}")
    
    def create_device(self, name: str, building_id: str, **kwargs) -> dict:
        """
        Create new device.
        
        Args:
            name: Device name
            building_id: Building UUID
            **kwargs: Additional device properties
            
        Returns:
            Created device object
        """
        data = {"name": name, "building_id": building_id, **kwargs}
        return self.post("/api/devices", data)
    
    def update_device_position(self, device_id: str, x: float, y: float) -> dict:
        """
        Update device floorplan position.
        
        Args:
            device_id: Device UUID
            x: X coordinate
            y: Y coordinate
            
        Returns:
            Updated device object
        """
        return self.put(f"/api/devices/{device_id}/position", {"x": x, "y": y})
    
    def delete_device(self, device_id: str) -> dict:
        """
        Delete device.
        
        Args:
            device_id: Device UUID
            
        Returns:
            Success status
        """
        return self.delete(f"/api/devices/{device_id}")

    def _fan_out(self, calls):
        """
        Run (method, arg) pairs concurrently; collect results and errors.

        Returns:
            (results, errors) — errors is a list of {"id", "error"}
        """
        from concurrent.futures import ThreadPoolExecutor
        results = []
        errors = []

        def run(item):
            method, arg = item
            try:
                return ("ok", method(arg))
            except Exception as e:
                return ("err", str(e))

        with ThreadPoolExecutor(max_workers=min(8, max(1, len(calls)))) as ex:
            for (method, arg), (status, payload) in zip(calls, ex.map(run, calls)):
                if status == "ok":
                    results.append(payload)
                else:
                    errors.append({"id": arg, "error": payload})
        return results, errors

    def batch_get_devices(self, device_ids: List[str]) -> dict:
        """
        Get multiple devices via concurrent requests.

        The backend has no batch endpoint; this fans out to GET
        /api/devices/{id} concurrently.

        Args:
            device_ids: List of device UUIDs

        Returns:
            {"data": [...], "errors": [...], "total": N}
        """
        results, errors = self._fan_out(
            [(self.get_device, did) for did in device_ids]
        )
        return {"data": results, "errors": errors, "total": len(results)}

    # ============================================================================
    # READINGS
    # ============================================================================

    def get_latest_readings(self, device_id: str) -> dict:
        """
        Get latest sensor readings.

        Args:
            device_id: Device UUID

        Returns:
            Latest readings; the newest reading is `result["readings"][0]`
        """
        return self.get(f"/api/readings/{device_id}")

    def get_historical_readings(self, device_id: str, days: int = 30) -> dict:
        """
        Get historical readings for a device.

        Args:
            device_id: Device UUID
            days: Number of days of history (backend default 30)

        Returns:
            Historical data
        """
        return self.get(f"/api/readings/{device_id}/historical", {"days": days})

    def get_device_readings(
        self,
        device_id: str,
        start: str = None,
        end: str = None,
        limit: int = None,
        aggregate: str = None,
    ) -> List[dict]:
        """
        Get readings for a device over an optional time window.

        Args:
            device_id: Device UUID
            start: Start date (ISO 8601)
            end: End date (ISO 8601)
            limit: Max number of readings (default 100)
            aggregate: Aggregation level e.g. "15min"

        Returns:
            List of reading objects
        """
        params: Dict[str, Any] = {}
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        if limit is not None:
            params["limit"] = limit
        if aggregate:
            params["aggregate"] = aggregate
        return self.get(f"/api/devices/{device_id}/readings", params or None)

    def batch_get_latest_readings(self, device_ids: List[str]) -> dict:
        """
        Get latest readings for multiple devices via concurrent requests.

        The backend's POST /api/readings/batch ingests readings; it does not
        fetch. This fans out to GET /api/readings/{id} concurrently.

        Args:
            device_ids: List of device UUIDs

        Returns:
            {"data": [...], "errors": [...], "total": N}
        """
        results, errors = self._fan_out(
            [(self.get_latest_readings, did) for did in device_ids]
        )
        return {"data": results, "errors": errors, "total": len(results)}

    # ============================================================================
    # IAQ ANALYSIS (computed client-side — mirrors kukios-mcp-server;
    # the platform API does not expose analysis endpoints)
    # ============================================================================

    @staticmethod
    def _unwrap_list(data) -> List[dict]:
        """Return a list from either a raw list or a {"data": [...]} payload."""
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            out = data.get("data")
            return out if isinstance(out, list) else []
        return []

    def _find_device(self, device_id: str):
        for d in self.list_devices():
            if d.get("id") == device_id:
                return d
        return None

    def _latest_reading(self, device_id: str):
        readings = self.get_latest_readings(device_id)
        rows = readings.get("readings") if isinstance(readings, dict) else None
        if not rows:
            return None
        return rows[0]

    @staticmethod
    def _param_score(param: str, value, thresholds: dict):
        """Score one parameter 0-100 against thresholds (mirrors mcp-server)."""
        good = thresholds.get("good")
        warning = thresholds.get("warning")
        critical = thresholds.get("critical")

        if isinstance(good, (list, tuple)):
            good_min, good_max = good
            warn_min, warn_max = warning
            if good_min <= value <= good_max:
                score = 100.0
            elif warn_min <= value <= warn_max:
                if value > good_max:
                    range_size = warn_max - good_max
                    distance = value - good_max
                else:
                    range_size = good_min - warn_min
                    distance = good_min - value
                score = max(50.0, 100.0 - (distance / range_size) * 50.0) if range_size else 50.0
            else:
                score = 25.0
        else:
            if good is not None and value <= good:
                score = 100.0
            elif warning is not None and value <= warning:
                range_size = warning - good
                distance = value - good
                score = max(50.0, 100.0 - (distance / range_size) * 50.0) if range_size else 50.0
            elif critical is not None and value <= critical:
                range_size = critical - warning
                distance = value - warning
                score = max(25.0, 50.0 - (distance / range_size) * 25.0) if range_size else 25.0
            else:
                score = 0.0
        return score

    @staticmethod
    def _severity_for(param: str, value, thresholds: dict) -> str:
        """Classify a parameter value as good/warning/critical."""
        good = thresholds.get("good")
        warning = thresholds.get("warning")
        critical = thresholds.get("critical")

        if isinstance(good, (list, tuple)):
            good_min, good_max = good
            warn_min, warn_max = warning
            crit_min, crit_max = critical
            if good_min <= value <= good_max:
                return "good"
            if crit_min <= value <= crit_max and value > warn_max:
                return "critical"
            return "warning"

        if good is not None and value <= good:
            return "good"
        if warning is not None and value <= warning:
            return "warning"
        return "critical"

    def analyze_iaq_quality(self, device_id: str, standard_code: str = "GOAQS") -> dict:
        """
        Analyze IAQ quality with issues and prioritized actions.

        Computed client-side from latest readings and thresholds, matching
        kukios-mcp-server behavior. Thresholds come from the named standard
        when available, falling back to built-in defaults.

        Args:
            device_id: Device UUID
            standard_code: Standard whose thresholds to use (default GOAQS)

        Returns:
            Analysis with overall grade, issues, prioritized actions
        """
        device = self._find_device(device_id)
        if not device:
            return {"error": f"Device not found: {device_id}"}

        latest = self._latest_reading(device_id)
        if latest is None:
            return {"error": "No readings available"}

        effective = self._effective_thresholds(standard_code)

        issues = []
        actions = []
        for param, thresholds in effective.items():
            value = latest.get(param)
            if value is None:
                continue
            severity = self._severity_for(param, value, thresholds)
            if severity == "good":
                continue

            unit = thresholds.get("unit", "")
            good = thresholds.get("good")
            issue = {
                "parameter": param,
                "value": value,
                "unit": unit,
                "severity": severity,
            }
            if isinstance(good, (list, tuple)):
                issue["acceptable_range"] = f"{good[0]}-{good[1]}{unit}"
            else:
                issue["acceptable_limit"] = f"<={good}{unit}"
            rec = IAQ_RECOMMENDATIONS.get(param, "")
            if rec:
                issue["recommendation"] = rec
                actions.append(
                    f"{severity.upper()}: {param} at {value}{unit} - {rec}"
                )
            issues.append(issue)

        if any(i["severity"] == "critical" for i in issues):
            grade = "D"
        elif len(issues) >= 2:
            grade = "C"
        elif len(issues) == 1:
            grade = "B"
        else:
            grade = "A"

        return {
            "device": device.get("name", "Unknown"),
            "overall_grade": grade,
            "issues_count": len(issues),
            "issues": issues,
            "prioritized_actions": actions[:5],
        }

    def _effective_thresholds(self, standard_code: str = None) -> dict:
        """
        Merge thresholds from a server-side standard with built-in defaults.
        Server format {"good","moderate","poor","unit"} maps to
        {"good","warning","critical","unit"}.
        """
        api_thresholds = {}
        if standard_code:
            try:
                standards = self._unwrap_list(self.list_standards())
                for s in standards:
                    if s.get("code") == standard_code:
                        t = s.get("thresholds") or {}
                        api_thresholds = {
                            k: {
                                "good": v.get("good"),
                                "warning": v.get("moderate"),
                                "critical": v.get("poor"),
                                "unit": v.get("unit", IAQ_THRESHOLDS.get(k, {}).get("unit", "")),
                            }
                            for k, v in t.items()
                            if isinstance(v, dict)
                        }
                        break
            except Exception:
                api_thresholds = {}

        effective = {}
        for param in set(list(api_thresholds.keys()) + list(IAQ_THRESHOLDS.keys())):
            if param in api_thresholds and api_thresholds[param]["good"] is not None:
                effective[param] = api_thresholds[param]
            else:
                effective[param] = IAQ_THRESHOLDS[param]
        return effective

    def get_iaq_recommendations(self, building_id: str = None) -> dict:
        """
        Get prioritized IAQ recommendations across devices.

        Args:
            building_id: Optional building UUID to filter devices by

        Returns:
            Aggregated analysis with prioritized actions (top 10)
        """
        devices = self.list_devices()
        if building_id:
            devices = [d for d in devices if d.get("building_id") == building_id]

        all_issues = []
        all_actions = []
        analyzed = 0
        for device in devices:
            analysis = self.analyze_iaq_quality(device["id"])
            if analysis.get("error"):
                continue
            analyzed += 1
            for issue in analysis.get("issues", []):
                issue = dict(issue)
                issue["device"] = device.get("name")
                all_issues.append(issue)
            all_actions.extend(analysis.get("prioritized_actions", []))

        severity_order = {"critical": 0, "warning": 1}
        all_issues.sort(key=lambda x: severity_order.get(x.get("severity"), 2))

        return {
            "devices_analyzed": analyzed,
            "total_issues": len(all_issues),
            "critical_issues": len([i for i in all_issues if i["severity"] == "critical"]),
            "warning_issues": len([i for i in all_issues if i["severity"] == "warning"]),
            "issues": all_issues,
            "prioritized_actions": all_actions[:10],
        }

    def get_iaq_health_score(self, device_id: str) -> dict:
        """
        Get an IAQ health score (0-100) with grade breakdown.

        Computed client-side from latest readings, mirroring
        kukios-mcp-server scoring.

        Args:
            device_id: Device UUID

        Returns:
            Health score with grade, message, and per-parameter breakdown
        """
        device = self._find_device(device_id)
        if not device:
            return {"error": f"Device not found: {device_id}"}

        latest = self._latest_reading(device_id)
        if latest is None:
            return {"error": "No readings available"}

        param_scores = {}
        total_score = 0.0
        param_count = 0

        for param, thresholds in IAQ_THRESHOLDS.items():
            value = latest.get(param)
            if value is None:
                continue
            score = self._param_score(param, value, thresholds)
            unit = thresholds.get("unit", "")
            status = (
                "\u2705 Good" if score >= 80
                else "\u26a0\ufe0f Warning" if score >= 50
                else "\U0001f534 Critical"
            )
            param_scores[param] = {
                "score": round(score),
                "value": value,
                "unit": unit,
                "status": status,
            }
            total_score += score
            param_count += 1

        overall = round(total_score / param_count) if param_count else 0

        if overall >= 90:
            grade, message = "A", "\u2705 Excellent air quality!"
        elif overall >= 75:
            grade, message = "B", "\u26a0\ufe0f Good, but some areas need improvement"
        elif overall >= 50:
            grade, message = "C", "\u26a0\ufe0f Fair - Several issues need attention"
        elif overall >= 25:
            grade, message = "D", "\U0001f534 Poor - Immediate action required"
        else:
            grade, message = "F", "\U0001f6a8 Critical - Urgent intervention needed"

        return {
            "device": device.get("name", "Unknown"),
            "health_score": overall,
            "grade": grade,
            "message": message,
            "parameters": param_scores,
        }

    def compare_to_standards(self, device_id: str, standard: str = "SS554") -> dict:
        """
        Compare latest readings against a named compliance standard.

        Fetches the standard's thresholds from /api/standards and evaluates
        the device's latest readings client-side (the platform has no
        per-device comparison endpoint).

        Args:
            device_id: Device UUID
            standard: Standard code (SS554, RESET, WELL, GOAQS, WHO, ...)

        Returns:
            Compliance analysis with per-parameter details
        """
        device = self._find_device(device_id)
        if not device:
            return {"error": f"Device not found: {device_id}"}

        std_data = None
        available = []
        try:
            for s in self._unwrap_list(self.list_standards()):
                code = s.get("code", "")
                available.append(code)
                if code == standard:
                    std_data = s
        except Exception:
            pass

        if std_data is None:
            return {
                "error": (
                    f"Unknown standard: {standard}. Available: "
                    + (", ".join(available) if available else "SS554, RESET, WELL, GOAQS, WHO")
                )
            }

        latest = self._latest_reading(device_id)
        if latest is None:
            return {"error": "No readings available"}

        thresholds = std_data.get("thresholds") or {}
        compliance = []
        for param, t in thresholds.items():
            if not isinstance(t, dict):
                continue
            value = latest.get(param)
            if value is None:
                continue
            good_val = t.get("good")
            moderate_val = t.get("moderate")
            poor_val = t.get("poor")
            unit = t.get("unit", "")
            if good_val is None:
                continue

            if isinstance(good_val, (int, float)):
                compliant = value <= good_val
                limit_str = f"<={good_val}"
            else:
                compliant = True
                limit_str = str(good_val)

            if compliant:
                status_label, severity = "\u2705 Compliant", "good"
            elif poor_val is not None and value > poor_val:
                status_label, severity = "\U0001f534 Poor", "poor"
            elif moderate_val is not None and value > moderate_val:
                status_label, severity = "\u26a0\ufe0f Moderate", "moderate"
            else:
                status_label, severity = "\u26a0\ufe0f Above good", "moderate"

            detail = {
                "parameter": param,
                "value": value,
                "unit": unit,
                "good_threshold": good_val,
                "moderate_threshold": moderate_val,
                "poor_threshold": poor_val,
                "compliant": compliant,
                "severity": severity,
                "status": status_label,
            }
            if t.get("avg_period"):
                detail["averaging_period"] = t["avg_period"]
            compliance.append(detail)

        checked = len(compliance)
        ok = len([c for c in compliance if c["compliant"]])
        return {
            "device": device.get("name", "Unknown"),
            "standard": standard,
            "standard_name": std_data.get("name", standard),
            "compliance_rate": f"{ok}/{checked}" if checked else "N/A",
            "fully_compliant": ok == checked and checked > 0,
            "parameters_checked": checked,
            "details": compliance,
        }

    # ============================================================================
    # COMPLIANCE
    # ============================================================================

    def list_standards(self) -> dict:
        """
        List compliance standards.

        Returns:
            Standards payload (list or {"data": [...]})
        """
        return self.get("/api/standards")

    def calculate_compliance(
        self,
        device_id: str,
        standard_id: str,
        start_time: str,
        end_time: str,
    ) -> dict:
        """
        Calculate compliance server-side over a time window.

        POSTs to /api/compliance/calculate as the backend expects.

        Args:
            device_id: Device UUID
            standard_id: Standard UUID (from list_standards)
            start_time: Window start (ISO 8601)
            end_time: Window end (ISO 8601)

        Returns:
            Compliance calculation result
        """
        return self.post("/api/compliance/calculate", {
            "sensorId": device_id,
            "standardId": standard_id,
            "startTime": start_time,
            "endTime": end_time,
        })

    # ============================================================================
    # REPORTS
    # ============================================================================

    def list_reports(
        self,
        page: int = 1,
        page_size: int = 100,
    ) -> dict:
        """
        List reports.

        Args:
            page: Page number (1-based)
            page_size: Items per page

        Returns:
            Reports payload
        """
        return self.get("/api/reports", {"page": page, "limit": page_size})

    def generate_report_pdf(self, report_id: str) -> dict:
        """
        Generate a PDF for an existing report.

        Args:
            report_id: Report UUID (from list_reports)

        Returns:
            PDF generation result
        """
        return self.post(f"/api/reports/{report_id}/pdf")

    # ============================================================================
    # OPERATIONS
    # ============================================================================

    def health_check(self) -> dict:
        """Platform health check (GET /health)."""
        return self.get("/health")

    def get_realtime_status(self) -> dict:
        """Real-time system status (no cache)."""
        return self.get("/api/operations/realtime")

    def get_sensor_history(self, device_id: str, hours: int = 24) -> dict:
        """
        Get sensor history.

        Args:
            device_id: Sensor/device UUID
            hours: Hours of history (default 24)

        Returns:
            History data
        """
        return self.get(
            f"/api/operations/sensors/{device_id}/history",
            {"hours": hours},
        )

    # ============================================================================
    # ALERTS
    # ============================================================================

    def list_alerts(
        self,
        status: str = None,
        severity: str = None,
        device_id: str = None,
        building_id: str = None,
        standard_code: str = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """
        List IAQ alerts.

        Args:
            status: Alert status (active, acknowledged, resolved)
            severity: Alert severity (critical, warning, info)
            device_id: Filter by device
            building_id: Filter by building
            standard_code: Filter by standard code
            page: Page number (1-based, backend default 1)
            page_size: Items per page (backend param is `limit`, default 50)

        Returns:
            Alerts payload
        """
        params: Dict[str, Any] = {"page": page, "limit": page_size}
        if status:
            params["status"] = status
        if severity:
            params["severity"] = severity
        if device_id:
            params["device_id"] = device_id
        if building_id:
            params["building_id"] = building_id
        if standard_code:
            params["standard_code"] = standard_code
        return self.get("/api/alerts", params)

    def acknowledge_alert(self, alert_id: str, notes: str = "") -> dict:
        """
        Acknowledge alert.

        Args:
            alert_id: Alert UUID
            notes: Optional acknowledgment notes

        Returns:
            Updated alert
        """
        return self.post(
            f"/api/alerts/{alert_id}/acknowledge",
            {"notes": notes} if notes else {},
        )

    def resolve_alert(self, alert_id: str, resolution: str = "") -> dict:
        """
        Resolve alert.

        Args:
            alert_id: Alert UUID
            resolution: Resolution notes (backend body field is `resolution`)

        Returns:
            Updated alert
        """
        return self.post(
            f"/api/alerts/{alert_id}/resolve",
            {"resolution": resolution} if resolution else {},
        )
