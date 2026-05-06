/**
 * KūkiOS MCP Client - Node.js Library
 * 
 * Official client library for connecting to KūkiOS IAQ Monitoring Platform via MCP.
 */

const axios = require('axios');

class KukiOSAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'KukiOSAuthError';
    }
}

class KukiOSAPIError extends Error {
    constructor(message, statusCode, response) {
        super(message);
        this.name = 'KukiOSAPIError';
        this.statusCode = statusCode;
        this.response = response;
    }
}

class KukiOSConnectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'KukiOSConnectionError';
    }
}

class KukiOSTimeoutError extends KukiOSConnectionError {
    constructor(message) {
        super(message);
        this.name = 'KukiOSTimeoutError';
    }
}

class KukiOSClient {
    /**
     * Initialize KūkiOS Client.
     * 
     * @param {Object} options - Client options
     * @param {string} options.url - KūkiOS MCP server URL
     * @param {string} options.email - User email for authentication
     * @param {string} options.password - User password for authentication
     * @param {number} options.timeout - Request timeout in milliseconds
     * @param {number} options.maxRetries - Maximum retry attempts
     * @param {number} options.retryDelay - Initial retry delay in milliseconds
     */
    constructor({
        url = process.env.KUKIOS_URL || 'https://dashbeta.what-if.sg',
        email = process.env.KUKIOS_EMAIL,
        password = process.env.KUKIOS_PASSWORD,
        timeout = 30000,
        maxRetries = 3,
        retryDelay = 1000
    } = {}) {
        this.url = url;
        this.email = email;
        this.password = password;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
        
        // Token management
        this._token = null;
        this._refreshToken = null;
        this._tokenExpiry = null;
        
        // Axios instance
        this.axios = axios.create({
            baseURL: url,
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        // Auto-login if credentials provided
        if (this.email && this.password) {
            this.authLogin(this.email, this.password);
        }
    }
    
    _headers() {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (this._token) {
            headers['Authorization'] = `Bearer ${this._token}`;
        }
        return headers;
    }
    
    _checkTokenExpiry() {
        if (!this._tokenExpiry) {
            return true;
        }
        // Refresh if token expires within 24 hours
        return Date.now() > (this._tokenExpiry - 86400000);
    }
    
    async _autoRefreshToken() {
        if (!this._refreshToken) {
            return false;
        }
        
        try {
            const response = await this.axios.post('/api/auth/refresh', {
                refreshToken: this._refreshToken
            });
            
            if (response.data.success && response.data.tokens) {
                this._token = response.data.tokens.accessToken;
                this._refreshToken = response.data.tokens.refreshToken;
                this._tokenExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }
    
    async _autoReauthenticate() {
        if (!this.email || !this.password) {
            return false;
        }
        
        try {
            const response = await this.axios.post('/api/auth/login', {
                email: this.email,
                password: this.password
            });
            
            if (response.data.success && response.data.tokens) {
                this._token = response.data.tokens.accessToken;
                this._refreshToken = response.data.tokens.refreshToken;
                this._tokenExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }
    
    async _checkAndRefreshToken() {
        if (!this._checkTokenExpiry()) {
            return true;
        }
        
        // Try refresh token first
        if (await this._autoRefreshToken()) {
            return true;
        }
        
        // Try full re-authentication
        if (await this._autoReauthenticate()) {
            return true;
        }
        
        return false;
    }
    
    async _request(method, path, data = null) {
        // Check token expiry before making request
        await this._checkAndRefreshToken();
        
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const config = {
                    method: method.toLowerCase(),
                    url: path,
                    headers: this._headers(),
                    timeout: this.timeout
                };
                
                if (data) {
                    config.data = data;
                }
                
                const response = await this.axios(config);
                
                if (response.status === 200) {
                    return response.data;
                } else if (response.status === 401) {
                    // Try re-auth and retry once
                    if (await this._autoReauthenticate()) {
                        config.headers = this._headers();
                        const retryResponse = await this.axios(config);
                        if (retryResponse.status === 200) {
                            return retryResponse.data;
                        }
                    }
                    throw new KukiOSAuthError('Authentication failed');
                } else {
                    throw new KukiOSAPIError(
                        `API error: ${response.status}`,
                        response.status,
                        response.data
                    );
                }
                
            } catch (error) {
                if (error instanceof KukiOSAuthError || error instanceof KukiOSAPIError) {
                    throw error;
                }
                
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                    if (attempt === this.maxRetries - 1) {
                        throw new KukiOSTimeoutError(`Request timed out after ${this.timeout}ms`);
                    }
                } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                    if (attempt === this.maxRetries - 1) {
                        throw new KukiOSConnectionError(`Connection failed: ${this.url}`);
                    }
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt)));
            }
        }
        
        throw new KukiOSAPIError(`Request failed after ${this.maxRetries} attempts`);
    }
    
    async get(path, params = null) {
        if (params) {
            const queryString = Object.entries(params)
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&');
            path = `${path}?${queryString}`;
        }
        return this._request('GET', path);
    }
    
    async post(path, data = null) {
        return this._request('POST', path, data);
    }
    
    async put(path, data = null) {
        return this._request('PUT', path, data);
    }
    
    async delete(path) {
        return this._request('DELETE', path);
    }
    
    // ============================================================================
    // AUTHENTICATION
    // ============================================================================
    
    async authLogin(email, password) {
        /**
         * Authenticate and store credentials for auto re-auth.
         * 
         * @param {string} email - User email
         * @param {string} password - User password
         * @returns {Object} Authentication response with tokens
         */
        const data = await this.post('/api/auth/login', { email, password });
        if (data.success && data.tokens) {
            this._token = data.tokens.accessToken;
            this._refreshToken = data.tokens.refreshToken;
            this._tokenExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
            this.email = email;
            this.password = password;
        }
        return data;
    }
    
    async authRefresh(refreshToken) {
        /**
         * Refresh JWT token using refresh token.
         * 
         * @param {string} refreshToken - Refresh token from login
         * @returns {Object} Refresh response with new tokens
         */
        const data = await this.post('/api/auth/refresh', { refreshToken });
        if (data.success && data.tokens) {
            this._token = data.tokens.accessToken;
            this._refreshToken = data.tokens.refreshToken;
            this._tokenExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
        }
        return data;
    }
    
    async getCurrentUser() {
        /**
         * Get current user info.
         * 
         * @returns {Object} User object with id, email, firstName, lastName, role
         */
        return this.get('/api/auth/me');
    }
    
    async getTokenStatus() {
        /**
         * Get current token status and expiry information.
         * 
         * @returns {Object} Token status with expiry time and auto-reauth capability
         */
        const status = {
            hasToken: !!this._token,
            hasRefreshToken: !!this._refreshToken,
            autoReauthEnabled: !!(this.email && this.password),
            tokenExpires: null
        };
        
        if (this._tokenExpiry) {
            const remaining = this._tokenExpiry - Date.now();
            status.tokenExpires = new Date(this._tokenExpiry).toISOString();
            status.remainingSeconds = Math.floor(remaining / 1000);
            status.remainingDays = Math.round(remaining / 86400000 * 10) / 10;
            status.needsRefresh = this._checkTokenExpiry();
        }
        
        return status;
    }
    
    // ============================================================================
    // BUILDINGS
    // ============================================================================
    
    async listBuildings(page = 0, pageSize = 100) {
        /**
         * List all buildings.
         * 
         * @param {number} page - Page number
         * @param {number} pageSize - Items per page
         * @returns {Object} Buildings list
         */
        return this.get('/api/buildings', { page, page_size: pageSize });
    }
    
    async getBuilding(buildingId) {
        /**
         * Get building details.
         * 
         * @param {string} buildingId - Building UUID
         * @returns {Object} Building object with levels
         */
        return this.get(`/api/buildings/${buildingId}`);
    }
    
    // ============================================================================
    // DEVICES
    // ============================================================================
    
    async listDevices() {
        /**
         * List all devices.
         * 
         * @returns {Array} List of device objects
         */
        const data = await this.get('/api/devices');
        return Array.isArray(data) ? data : (data.data || []);
    }
    
    async getDevice(deviceId) {
        /**
         * Get device details.
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} Device object
         */
        return this.get(`/api/devices/${deviceId}`);
    }
    
    async createDevice(name, buildingId, ...kwargs) {
        /**
         * Create new device.
         * 
         * @param {string} name - Device name
         * @param {string} buildingId - Building UUID
         * @param {Object} kwargs - Additional device properties
         * @returns {Object} Created device object
         */
        const data = { name, building_id: buildingId, ...kwargs };
        return this.post('/api/devices', data);
    }
    
    async updateDevicePosition(deviceId, x, y) {
        /**
         * Update device floorplan position.
         * 
         * @param {string} deviceId - Device UUID
         * @param {number} x - X coordinate
         * @param {number} y - Y coordinate
         * @returns {Object} Updated device object
         */
        return this.put(`/api/devices/${deviceId}/position`, { x, y });
    }
    
    async deleteDevice(deviceId) {
        /**
         * Delete device.
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} Success status
         */
        return this.delete(`/api/devices/${deviceId}`);
    }
    
    async batchGetDevices(deviceIds) {
        /**
         * Get multiple devices.
         * 
         * @param {Array} deviceIds - List of device UUIDs
         * @returns {Object} {"data": [...], "errors": [...]}
         */
        return this.post('/api/devices/batch', { device_ids: deviceIds });
    }
    
    // ============================================================================
    // READINGS
    // ============================================================================
    
    async getLatestReadings(deviceId) {
        /**
         * Get latest sensor readings.
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} Latest readings
         */
        return this.get(`/api/readings/${deviceId}`);
    }
    
    async getHistoricalReadings(deviceId, startDate, endDate, aggregate = null) {
        /**
         * Get historical readings.
         * 
         * @param {string} deviceId - Device UUID
         * @param {string} startDate - Start date (ISO)
         * @param {string} endDate - End date (ISO)
         * @param {string} aggregate - Aggregation level
         * @returns {Object} Historical data
         */
        const params = { start: startDate, end: endDate };
        if (aggregate) {
            params.aggregate = aggregate;
        }
        return this.get(`/api/readings/${deviceId}/historical`, params);
    }
    
    async batchGetLatestReadings(deviceIds) {
        /**
         * Get latest readings for multiple devices.
         * 
         * @param {Array} deviceIds - List of device UUIDs
         * @returns {Object} {"data": [...], "errors": [...]}
         */
        return this.post('/api/readings/batch', { device_ids: deviceIds });
    }
    
    // ============================================================================
    // IAQ ANALYSIS
    // ============================================================================
    
    async analyzeIAQQuality(deviceId) {
        /**
         * Analyze IAQ quality with recommendations.
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} IAQ analysis with recommendations
         */
        return this.get(`/api/analyze/${deviceId}`);
    }
    
    async getIAQRecommendations(deviceId) {
        /**
         * Get prioritized IAQ recommendations.
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} Prioritized recommendations
         */
        return this.get(`/api/recommendations/${deviceId}`);
    }
    
    async getIAQHealthScore(deviceId) {
        /**
         * Get IAQ health score (0-100).
         * 
         * @param {string} deviceId - Device UUID
         * @returns {Object} Health score with grade
         */
        return this.get(`/api/health/${deviceId}`);
    }
    
    async compareToStandards(deviceId, standard = 'SS554') {
        /**
         * Compare readings against specific IAQ standard.
         * 
         * @param {string} deviceId - Device UUID
         * @param {string} standard - Standard to compare against (SS554, RESET, WELL, GOAQS, WHO)
         * @returns {Object} Compliance analysis with recommendations
         */
        return this.get(`/api/standards/${deviceId}`, { standard });
    }
    
    // ============================================================================
    // COMPLIANCE
    // ============================================================================
    
    async listStandards() {
        /**
         * List compliance standards.
         * 
         * @returns {Object} List of standards
         */
        return this.get('/api/standards');
    }
    
    async calculateCompliance(deviceId, standard = 'SS554') {
        /**
         * Calculate compliance grade.
         * 
         * @param {string} deviceId - Device UUID
         * @param {string} standard - Standard to calculate against
         * @returns {Object} Compliance grade
         */
        return this.post(`/api/compliance/${deviceId}`, { standard });
    }
    
    // ============================================================================
    // REPORTS
    // ============================================================================
    
    async listReports() {
        /**
         * List reports.
         * 
         * @returns {Object} List of reports
         */
        return this.get('/api/reports');
    }
    
    async generateReportPDF(buildingId = null) {
        /**
         * Generate PDF report.
         * 
         * @param {string} buildingId - Optional building UUID
         * @returns {Object} PDF report URL
         */
        const params = {};
        if (buildingId) {
            params.building_id = buildingId;
        }
        return this.post('/api/reports/generate', params);
    }
    
    // ============================================================================
    // ALERTS
    // ============================================================================
    
    async listAlerts({ status, severity, deviceId, buildingId } = {}) {
        /**
         * List IAQ alerts.
         * 
         * @param {Object} options - Filter options
         * @param {string} options.status - Alert status (active, acknowledged, resolved)
         * @param {string} options.severity - Alert severity (critical, warning, info)
         * @param {string} options.deviceId - Filter by device
         * @param {string} options.buildingId - Filter by building
         * @returns {Object} List of alerts
         */
        const params = {};
        if (status) params.status = status;
        if (severity) params.severity = severity;
        if (deviceId) params.device_id = deviceId;
        if (buildingId) params.building_id = buildingId;
        return this.get('/api/alerts', params);
    }
    
    async acknowledgeAlert(alertId) {
        /**
         * Acknowledge alert.
         * 
         * @param {string} alertId - Alert UUID
         * @returns {Object} Updated alert
         */
        return this.put(`/api/alerts/${alertId}/acknowledge`);
    }
    
    async resolveAlert(alertId) {
        /**
         * Resolve alert.
         * 
         * @param {string} alertId - Alert UUID
         * @returns {Object} Updated alert
         */
        return this.put(`/api/alerts/${alertId}/resolve`);
    }
}

module.exports = {
    KukiOSClient,
    KukiOSAuthError,
    KukiOSAPIError,
    KukiOSConnectionError,
    KukiOSTimeoutError
};
