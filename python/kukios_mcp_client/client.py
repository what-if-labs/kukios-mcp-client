"""
KūkiOS MCP Client - Main Client Module
"""

import os
import time
import requests
from typing import Optional, Dict, Any, List
from .exceptions import KukiOSAuthError, KukiOSAPIError, KukiOSConnectionError, KukiOSTimeoutError


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
        cache_ttl: int = 300
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
            cache_ttl: Cache TTL in seconds
        """
        self.url = url or os.getenv("KUKIOS_URL", "https://dashbeta.what-if.sg")
        self.email = email or os.getenv("KUKIOS_EMAIL")
        self.password = password or os.getenv("KUKIOS_PASSWORD")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        
        # Token management
        self._token = None
        self._refresh_token = None
        self._token_expiry = None
        
        # Session
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10,
            pool_maxsize=10,
            max_retries=requests.adapters.Retry(
                total=max_retries,
                backoff_factor=retry_delay,
                status_forcelist=[429, 500, 502, 503, 504]
            )
        )
        self.session.mount('http://', adapter)
        self.session.mount('https://', adapter)
        
        # Auto-login if credentials provided
        if self.email and self.password:
            self.auth_login(self.email, self.password)
    
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
            
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success") and data.get("tokens"):
                    self._token = data["tokens"]["accessToken"]
                    self._refresh_token = data["tokens"]["refreshToken"]
                    self._token_expiry = time.time() + (30 * 24 * 60 * 60)  # 30 days
                    return True
            return False
        except Exception:
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
            
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success") and data.get("tokens"):
                    self._token = data["tokens"]["accessToken"]
                    self._refresh_token = data["tokens"]["refreshToken"]
                    self._token_expiry = time.time() + (30 * 24 * 60 * 60)  # 30 days
                    return True
            return False
        except Exception:
            return False
    
    def _check_and_refresh_token(self) -> bool:
        """Check if token needs refresh and attempt refresh."""
        if not self._check_token_expiry():
            return True
        
        # Try refresh token first
        if self._auto_refresh_token():
            return True
        
        # Try full re-authentication
        if self._auto_reauthenticate():
            return True
        
        return False
    
    def _request(self, method: str, path: str, json_data: dict = None) -> dict:
        """Make API request with auto re-auth."""
        # Check token expiry before making request
        self._check_and_refresh_token()
        
        url = f"{self.url}{path}"
        
        for attempt in range(self.max_retries):
            try:
                resp = self.session.request(
                    method,
                    url,
                    headers=self._headers(),
                    json=json_data,
                    timeout=self.timeout
                )
                
                # Handle 401 - try re-auth and retry once
                if resp.status_code == 401:
                    if self._auto_reauthenticate():
                        resp = self.session.request(
                            method,
                            url,
                            headers=self._headers(),
                            json=json_data,
                            timeout=self.timeout
                        )
                
                if resp.status_code == 200:
                    return resp.json()
                elif resp.status_code == 401:
                    raise KukiOSAuthError("Authentication failed")
                else:
                    raise KukiOSAPIError(
                        f"API error: {resp.status_code}",
                        status_code=resp.status_code,
                        response=resp.text
                    )
                    
            except requests.exceptions.Timeout:
                if attempt == self.max_retries - 1:
                    raise KukiOSTimeoutError(f"Request timed out after {self.timeout}s")
                time.sleep(self.retry_delay * (2 ** attempt))
            except requests.exceptions.ConnectionError:
                if attempt == self.max_retries - 1:
                    raise KukiOSConnectionError(f"Connection failed: {self.url}")
                time.sleep(self.retry_delay * (2 ** attempt))
        
        raise KukiOSAPIError(f"Request failed after {self.max_retries} attempts")
    
    def get(self, path: str, params: dict = None) -> dict:
        """GET request."""
        if params:
            path = f"{path}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
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
            self._token = data["tokens"]["accessToken"]
            self._refresh_token = data["tokens"]["refreshToken"]
            self._token_expiry = time.time() + (30 * 24 * 60 * 60)  # 30 days
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
            self._token = data["tokens"]["accessToken"]
            self._refresh_token = data["tokens"]["refreshToken"]
            self._token_expiry = time.time() + (30 * 24 * 60 * 60)  # 30 days
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
            List of device objects
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
    
    def batch_get_devices(self, device_ids: List[str]) -> dict:
        """
        Get multiple devices.
        
        Args:
            device_ids: List of device UUIDs
            
        Returns:
            {"data": [...], "errors": [...]}
        """
        return self.post("/api/devices/batch", {"device_ids": device_ids})
    
    # ============================================================================
    # READINGS
    # ============================================================================
    
    def get_latest_readings(self, device_id: str) -> dict:
        """
        Get latest sensor readings.
        
        Args:
            device_id: Device UUID
            
        Returns:
            Latest readings
        """
        return self.get(f"/api/readings/{device_id}")
    
    def get_historical_readings(
        self,
        device_id: str,
        start_date: str,
        end_date: str,
        aggregate: str = None
    ) -> dict:
        """
        Get historical readings.
        
        Args:
            device_id: Device UUID
            start_date: Start date (ISO)
            end_date: End date (ISO)
            aggregate: Aggregation level
            
        Returns:
            Historical data
        """
        params = {"start": start_date, "end": end_date}
        if aggregate:
            params["aggregate"] = aggregate
        return self.get(f"/api/readings/{device_id}/historical", params)
    
    def batch_get_latest_readings(self, device_ids: List[str]) -> dict:
        """
        Get latest readings for multiple devices.
        
        Args:
            device_ids: List of device UUIDs
            
        Returns:
            {"data": [...], "errors": [...]}
        """
        return self.post("/api/readings/batch", {"device_ids": device_ids})
    
    # ============================================================================
    # IAQ ANALYSIS
    # ============================================================================
    
    def analyze_iaq_quality(self, device_id: str) -> dict:
        """
        Analyze IAQ quality with recommendations.
        
        Args:
            device_id: Device UUID
            
        Returns:
            IAQ analysis with recommendations
        """
        return self.get(f"/api/analyze/{device_id}")
    
    def get_iaq_recommendations(self, device_id: str) -> dict:
        """
        Get prioritized IAQ recommendations.
        
        Args:
            device_id: Device UUID
            
        Returns:
            Prioritized recommendations
        """
        return self.get(f"/api/recommendations/{device_id}")
    
    def get_iaq_health_score(self, device_id: str) -> dict:
        """
        Get IAQ health score (0-100).
        
        Args:
            device_id: Device UUID
            
        Returns:
            Health score with grade
        """
        return self.get(f"/api/health/{device_id}")
    
    def compare_to_standards(self, device_id: str, standard: str = "SS554") -> dict:
        """
        Compare readings against specific IAQ standard.
        
        Args:
            device_id: Device UUID
            standard: Standard to compare against (SS554, RESET, WELL, GOAQS, WHO)
            
        Returns:
            Compliance analysis with recommendations
        """
        return self.get(f"/api/standards/{device_id}", {"standard": standard})
    
    # ============================================================================
    # COMPLIANCE
    # ============================================================================
    
    def list_standards(self) -> dict:
        """
        List compliance standards.
        
        Returns:
            List of standards
        """
        return self.get("/api/standards")
    
    def calculate_compliance(self, device_id: str, standard: str = "SS554") -> dict:
        """
        Calculate compliance grade.
        
        Args:
            device_id: Device UUID
            standard: Standard to calculate against
            
        Returns:
            Compliance grade
        """
        return self.post(f"/api/compliance/{device_id}", {"standard": standard})
    
    # ============================================================================
    # REPORTS
    # ============================================================================
    
    def list_reports(self) -> dict:
        """
        List reports.
        
        Returns:
            List of reports
        """
        return self.get("/api/reports")
    
    def generate_report_pdf(self, building_id: str = None) -> dict:
        """
        Generate PDF report.
        
        Args:
            building_id: Optional building UUID
            
        Returns:
            PDF report URL
        """
        params = {}
        if building_id:
            params["building_id"] = building_id
        return self.post("/api/reports/generate", params)
    
    # ============================================================================
    # ALERTS
    # ============================================================================
    
    def list_alerts(
        self,
        status: str = None,
        severity: str = None,
        device_id: str = None,
        building_id: str = None
    ) -> dict:
        """
        List IAQ alerts.
        
        Args:
            status: Alert status (active, acknowledged, resolved)
            severity: Alert severity (critical, warning, info)
            device_id: Filter by device
            building_id: Filter by building
            
        Returns:
            List of alerts
        """
        params = {}
        if status:
            params["status"] = status
        if severity:
            params["severity"] = severity
        if device_id:
            params["device_id"] = device_id
        if building_id:
            params["building_id"] = building_id
        return self.get("/api/alerts", params)
    
    def acknowledge_alert(self, alert_id: str) -> dict:
        """
        Acknowledge alert.
        
        Args:
            alert_id: Alert UUID
            
        Returns:
            Updated alert
        """
        return self.put(f"/api/alerts/{alert_id}/acknowledge")
    
    def resolve_alert(self, alert_id: str) -> dict:
        """
        Resolve alert.
        
        Args:
            alert_id: Alert UUID
            
        Returns:
            Updated alert
        """
        return self.put(f"/api/alerts/{alert_id}/resolve")
