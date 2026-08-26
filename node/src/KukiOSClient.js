/**
 * KūkiOS MCP Client - Node.js Library
 * 
 * Official client library for connecting to KūkiOS IAQ Monitoring Platform via MCP.
 */

const axios = require('axios');

// IAQ thresholds — mirrors kukios-mcp-server (IAQ_THRESHOLDS).
// Range-based params use [good_min, good_max] arrays; scalar params
// use upper-bound thresholds.
const IAQ_THRESHOLDS = {
    temperature: { good: [23, 26], warning: [26, 28], critical: [28, 35], unit: '°C' },
    humidity: { good: [40, 60], warning: [30, 70], critical: [0, 100], unit: '%' },
    pm25: { good: 15, warning: 35, critical: 55, unit: 'µg/m³' },
    pm10: { good: 45, warning: 65, critical: 100, unit: 'µg/m³' },
    co2: { good: 600, warning: 800, critical: 1000, unit: 'ppm' },
    tvoc: { good: 500, warning: 1000, critical: 2000, unit: 'µg/m³' },
    formaldehyde: { good: 80, warning: 120, critical: 200, unit: 'µg/m³' }
};

const IAQ_RECOMMENDATIONS = {
    temperature: 'Adjust HVAC setpoints. Check zoning and solar gain.',
    humidity: 'Adjust HVAC dehumidification/humidification. Check for moisture sources.',
    pm25: 'Check/replace HVAC filters. Increase air filtration. Check for indoor sources (cooking, smoking).',
    pm10: 'Check HVAC filters. Reduce dust sources. Increase cleaning frequency.',
    co2: 'Increase ventilation. Open windows or increase fresh air intake. Check occupancy levels.',
    tvoc: 'Identify VOC source immediately. Check for new furniture, cleaning products, paint, or solvents. Increase ventilation.',
    formaldehyde: 'Check for formaldehyde sources (pressed wood, adhesives). Increase ventilation. Consider air purifier with activated carbon.'
};

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
        url = process.env.IAQ_REPORTER_URL || process.env.KUKIOS_URL || 'https://dashbeta.what-if.sg',
        email = process.env.IAQ_EMAIL || process.env.KUKIOS_EMAIL,
        password = process.env.IAQ_PASSWORD || process.env.KUKIOS_PASSWORD,
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
        // Token management (IAQ_TOKEN / IAQ_REFRESH_TOKEN match mcp-server convention)
        this._token = process.env.IAQ_TOKEN || null;
        this._refreshToken = process.env.IAQ_REFRESH_TOKEN || null;
        this._tokenExpiry = this._jwtExp(this._token);

        // Axios instance
        this.axios = axios.create({
            baseURL: url,
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // Auto-login if credentials provided. `ready` resolves when the
        // initial login settles (or rejects). Callers who care should
        // `await client.ready` before issuing requests.
        if (this.email && this.password) {
            this.ready = this.authLogin(this.email, this.password)
                .catch(err => { this._initError = err; });
        } else {
            this.ready = Promise.resolve();
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
        // Access tokens are short-lived (backend issues expiresIn=900s).
        // Proactively refresh only in the final minute; the 401 handler
        // covers the rest. Refreshing earlier would burn the backend's
        // /api/auth/* rate limit (10 requests / 15 min) on every call.
        return Date.now() > (this._tokenExpiry - 60000);
    }
    
    _jwtExp(token) {
        if (!token) return null;
        try {
            const payload = token.split('.')[1];
            if (!payload) return null;
            const padded = payload + '='.repeat((-payload.length) % 4);
            const data = JSON.parse(
                Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
            );
            return typeof data.exp === 'number' ? data.exp * 1000 : null;
        } catch {
            return null;
        }
    }

    _storeTokens(accessToken, refreshToken) {
        this._token = accessToken;
        if (refreshToken !== undefined && refreshToken !== null) {
            this._refreshToken = refreshToken;
        }
        const exp = this._jwtExp(accessToken);
        this._tokenExpiry = exp !== null
            ? exp
            : Date.now() + (30 * 24 * 60 * 60 * 1000);
    }

    async _autoRefreshToken() {
        if (!this._refreshToken) {
            return false;
        }
        try {
            const response = await this.axios.post('/api/auth/refresh', {
                refreshToken: this._refreshToken
            });
            const data = KukiOSClient._unwrapEnvelope(response.data);
            if (!data || !data.tokens) {
                return false;
            }
            this._storeTokens(
                response.data.tokens.accessToken,
                response.data.tokens.refreshToken,
            );
            return true;
        } catch {
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
            const data = KukiOSClient._unwrapEnvelope(response.data);
            if (!data || !data.tokens) {
                return false;
            }
            this._storeTokens(
                data.tokens.accessToken,
                data.tokens.refreshToken,
            );
            return true;
        } catch {
            return false;
        }
    }

    async _checkAndRefreshToken() {
        if (!this._checkTokenExpiry()) {
            return true;
        }
        return (await this._autoRefreshToken()) || (await this._autoReauthenticate());
    }

    async _sleepBackoff(attempt) {
        if (attempt >= this.maxRetries - 1) return;
        const ms = this.retryDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    async _request(method, path, data = null) {
        await this._checkAndRefreshToken();

        let lastError = null;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            const config = {
                method: method.toLowerCase(),
                url: path,
                headers: this._headers(),
                timeout: this.timeout
            };
            if (data) {
                config.data = data;
            }

            let response;
            try {
                response = await this.axios(config);
            } catch (error) {
                const code = error && error.code;
                if (code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
                    lastError = new KukiOSTimeoutError(`Request timed out after ${this.timeout}ms`);
                } else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
                    lastError = new KukiOSConnectionError(`Connection failed: ${this.url}`);
                } else {
                    // Non-retryable transport error.
                    throw new KukiOSConnectionError(`Request failed: ${error.message || error}`);
                }
                await this._sleepBackoff(attempt);
                continue;
            }

            // 401: try refresh, then re-auth, then retry once.
            if (response.status === 401) {
                if ((await this._autoRefreshToken()) || (await this._autoReauthenticate())) {
                    config.headers = this._headers();
                    try {
                        response = await this.axios(config);
                    } catch (error) {
                        throw lastError || new KukiOSAPIError('Retry after auth failed');
                    }
                } else {
                    throw new KukiOSAuthError('Authentication failed');
                }
            }

            if (response.status >= 200 && response.status < 300) {
                if (response.status === 204 || !response.data) return {};
                return KukiOSClient._unwrapEnvelope(response.data);
            }

            if (response.status >= 400 && response.status < 500) {
                if (response.status === 401) {
                    throw new KukiOSAuthError(KukiOSClient._serverError(response));
                }
                throw new KukiOSAPIError(
                    KukiOSClient._serverError(response),
                    response.status,
                    response.data
                );
            }

            // 5xx — retryable.
            lastError = new KukiOSAPIError(
                `API error: ${response.status}`,
                response.status,
                response.data
            );
            await this._sleepBackoff(attempt);
        }

        if (lastError) throw lastError;
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
        if (data && data.tokens) {
            this._storeTokens(data.tokens.accessToken, data.tokens.refreshToken);
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
        if (data && data.tokens) {
            this._storeTokens(data.tokens.accessToken, data.tokens.refreshToken);
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
         * Tries GET /api/devices/{id} first; the deployed backend does not
         * mount that route, so on 404 this falls back to a list scan.
         *
         * @param {string} deviceId - Device UUID
         * @returns {Object} Device object
         */
        try {
            return await this.get(`/api/devices/${deviceId}`);
        } catch (e) {
            if (!(e instanceof KukiOSAPIError) || e.statusCode !== 404) throw e;
        }
        const device = await this._findDevice(deviceId);
        if (!device) {
            throw new KukiOSAPIError(`Device not found: ${deviceId}`, 404, null);
        }
        return device;
    }
    
    async createDevice(name, buildingId, ...extra) {
        /**
         * Create new device.
         *
         * @param {string} name - Device name
         * @param {string} buildingId - Building UUID
         * @param {...Object} extra - Additional device properties
         * @returns {Object} Created device object
         */
        const data = { name, building_id: buildingId, ...extra };
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
    
    async _fanOut(calls) {
        /**
         * Run thunks concurrently; collect results and errors.
         * @param {Array<Function>} calls - Thunks returning promises
         * @returns {Promise<{data: Array, errors: Array, total: number}>}
         */
        const settled = await Promise.allSettled(calls.map(fn => fn()));
        const data = [];
        const errors = [];
        settled.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                data.push(r.value);
            } else {
                errors.push({ index: i, error: String(r.reason && r.reason.message || r.reason) });
            }
        });
        return { data, errors, total: data.length };
    }

    async batchGetDevices(deviceIds) {
        /**
         * Get multiple devices via concurrent requests.
         *
         * The backend has no batch endpoint; this fans out to
         * GET /api/devices/{id} concurrently.
         *
         * @param {Array<string>} deviceIds - List of device UUIDs
         * @returns {Object} {"data": [...], "errors": [...], "total": N}
         */
        return this._fanOut(deviceIds.map(id => () => this.getDevice(id)));
    }

    // ============================================================================
    // READINGS
    // ============================================================================

    async getLatestReadings(deviceId) {
        /**
         * Get latest sensor readings.
         *
         * @param {string} deviceId - Device UUID
         * @returns {Object} Latest readings; newest is result.readings[0]
         */
        return this.get(`/api/readings/${deviceId}`);
    }

    async getHistoricalReadings(deviceId, days = 30) {
        /**
         * Get historical readings for a device.
         *
         * @param {string} deviceId - Device UUID
         * @param {number} [days] - Days of history (backend default 30)
         * @returns {Object} Historical data
         */
        return this.get(`/api/readings/${deviceId}/historical`, { days });
    }

    async getDeviceReadings({ deviceId, start = null, end = null, limit = null, aggregate = null }) {
        /**
         * Get readings for a device over an optional time window.
         *
         * @param {Object} options
         * @param {string} options.deviceId - Device UUID
         * @param {string} [options.start] - Start date (ISO 8601)
         * @param {string} [options.end] - End date (ISO 8601)
         * @param {number} [options.limit] - Max readings (default 100)
         * @param {string} [options.aggregate] - Aggregation level e.g. "15min"
         * @returns {Array} Reading objects
         */
        const params = {};
        if (start) params.start = start;
        if (end) params.end = end;
        if (limit !== null && limit !== undefined) params.limit = limit;
        if (aggregate) params.aggregate = aggregate;
        return this.get(`/api/devices/${deviceId}/readings`, Object.keys(params).length ? params : null);
    }

    async batchGetLatestReadings(deviceIds) {
        /**
         * Get latest readings for multiple devices via concurrent requests.
         *
         * The backend's POST /api/readings/batch ingests readings; it does not
         * fetch. This fans out to GET /api/readings/{id} concurrently.
         *
         * @param {Array<string>} deviceIds - List of device UUIDs
         * @returns {Object} {"data": [...], "errors": [...], "total": N}
         */
        return this._fanOut(deviceIds.map(id => () => this.getLatestReadings(id)));
    }

    // ============================================================================
    // IAQ ANALYSIS (computed client-side — mirrors kukios-mcp-server;
    // the platform API does not expose analysis endpoints)
    // ============================================================================

    _unwrapList(data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.data)) return data.data;
        return [];
    }

    async _findDevice(deviceId) {
        const devices = await this.listDevices();
        return devices.find(d => d.id === deviceId) || null;
    }

    async _latestReading(deviceId) {
        const readings = await this.getLatestReadings(deviceId);
        const rows = readings && Array.isArray(readings.readings) ? readings.readings : null;
        return rows && rows.length ? rows[0] : null;
    }

    /**
     * Unwrap the backend's {success, data, error} response envelope.
     * The kukios API wraps every payload via wrapResponse middleware.
     */
    static _unwrapEnvelope(payload) {
        if (
            payload && typeof payload === 'object' && !Array.isArray(payload)
            && 'data' in payload
            && ('success' in payload || 'error' in payload)
        ) {
            return payload.data === null || payload.data === undefined ? {} : payload.data;
        }
        return payload;
    }

    /** Best-effort extraction of the server's error code/message. */
    static _serverError(response) {
        let detail = '';
        const body = response && response.data;
        if (body && typeof body === 'object') {
            detail = String(body.error || body.message || '');
        }
        const msg = `API error: ${response.status}`;
        return detail ? `${msg} (${detail})` : msg;
    }

    static _paramScore(value, thresholds) {
        const good = thresholds.good;
        const warning = thresholds.warning;
        const critical = thresholds.critical;

        if (Array.isArray(good)) {
            const [goodMin, goodMax] = good;
            const [warnMin, warnMax] = warning;
            if (value >= goodMin && value <= goodMax) return 100;
            if (value >= warnMin && value <= warnMax) {
                let rangeSize, distance;
                if (value > goodMax) { rangeSize = warnMax - goodMax; distance = value - goodMax; }
                else { rangeSize = goodMin - warnMin; distance = goodMin - value; }
                return rangeSize ? Math.max(50, 100 - (distance / rangeSize) * 50) : 50;
            }
            return 25;
        }

        if (good !== null && good !== undefined && value <= good) return 100;
        if (warning !== null && warning !== undefined && value <= warning) {
            const rangeSize = warning - good;
            const distance = value - good;
            return rangeSize ? Math.max(50, 100 - (distance / rangeSize) * 50) : 50;
        }
        if (critical !== null && critical !== undefined && value <= critical) {
            const rangeSize = critical - warning;
            const distance = value - warning;
            return rangeSize ? Math.max(25, 50 - (distance / rangeSize) * 25) : 25;
        }
        return 0;
    }

    static _severityFor(value, thresholds) {
        const good = thresholds.good;
        const warning = thresholds.warning;
        const critical = thresholds.critical;

        if (Array.isArray(good)) {
            const [goodMin, goodMax] = good;
            const [warnMin, warnMax] = warning;
            const [critMin, critMax] = critical;
            if (value >= goodMin && value <= goodMax) return 'good';
            if (value > warnMax && value >= critMin && value <= critMax) return 'critical';
            return 'warning';
        }

        if (good !== null && good !== undefined && value <= good) return 'good';
        if (warning !== null && warning !== undefined && value <= warning) return 'warning';
        return 'critical';
    }

    async _effectiveThresholds(standardCode = null) {
        const apiThresholds = {};
        if (standardCode) {
            try {
                const standards = this._unwrapList(await this.listStandards());
                const std = standards.find(s => s.code === standardCode);
                if (std && std.thresholds) {
                    for (const [k, v] of Object.entries(std.thresholds)) {
                        if (v && typeof v === 'object') {
                            apiThresholds[k] = {
                                good: v.good,
                                warning: v.moderate,
                                critical: v.poor,
                                unit: v.unit || (IAQ_THRESHOLDS[k] ? IAQ_THRESHOLDS[k].unit : '')
                            };
                        }
                    }
                }
            } catch { /* fall back to built-ins */ }
        }

        const effective = {};
        for (const param of new Set([...Object.keys(apiThresholds), ...Object.keys(IAQ_THRESHOLDS)])) {
            const t = apiThresholds[param];
            if (t && t.good !== null && t.good !== undefined) effective[param] = t;
            else effective[param] = IAQ_THRESHOLDS[param];
        }
        return effective;
    }

    async analyzeIAQQuality(deviceId, standardCode = 'GOAQS') {
        /**
         * Analyze IAQ quality with issues and prioritized actions.
         *
         * Computed client-side from latest readings and thresholds, matching
         * kukios-mcp-server behavior.
         *
         * @param {string} deviceId - Device UUID
         * @param {string} [standardCode] - Standard whose thresholds to use (default GOAQS)
         * @returns {Object} Analysis with overall grade, issues, prioritized actions
         */
        const device = await this._findDevice(deviceId);
        if (!device) return { error: `Device not found: ${deviceId}` };

        const latest = await this._latestReading(deviceId);
        if (!latest) return { error: 'No readings available' };

        const effective = await this._effectiveThresholds(standardCode);
        const issues = [];
        const actions = [];

        for (const [param, thresholds] of Object.entries(effective)) {
            const value = latest[param];
            if (value === null || value === undefined) continue;
            const severity = KukiOSClient._severityFor(value, thresholds);
            if (severity === 'good') continue;

            const unit = thresholds.unit || '';
            const issue = { parameter: param, value, unit, severity };
            if (Array.isArray(thresholds.good)) {
                issue.acceptable_range = `${thresholds.good[0]}-${thresholds.good[1]}${unit}`;
            } else {
                issue.acceptable_limit = `<=${thresholds.good}${unit}`;
            }
            const rec = IAQ_RECOMMENDATIONS[param];
            if (rec) {
                issue.recommendation = rec;
                actions.push(`${severity.toUpperCase()}: ${param} at ${value}${unit} - ${rec}`);
            }
            issues.push(issue);
        }

        let grade;
        if (issues.some(i => i.severity === 'critical')) grade = 'D';
        else if (issues.length >= 2) grade = 'C';
        else if (issues.length === 1) grade = 'B';
        else grade = 'A';

        return {
            device: device.name || 'Unknown',
            overall_grade: grade,
            issues_count: issues.length,
            issues,
            prioritized_actions: actions.slice(0, 5)
        };
    }

    async getIAQRecommendations(buildingId = null) {
        /**
         * Get prioritized IAQ recommendations across devices.
         *
         * @param {string} [buildingId] - Optional building UUID to filter devices by
         * @returns {Object} Aggregated analysis with prioritized actions (top 10)
         */
        let devices = await this.listDevices();
        if (buildingId) {
            devices = devices.filter(d => d.building_id === buildingId);
        }

        const allIssues = [];
        const allActions = [];
        let analyzed = 0;
        for (const device of devices) {
            const analysis = await this.analyzeIAQQuality(device.id);
            if (analysis.error) continue;
            analyzed += 1;
            for (const issue of analysis.issues || []) {
                allIssues.push({ ...issue, device: device.name });
            }
            allActions.push(...(analysis.prioritized_actions || []));
        }

        const severityOrder = { critical: 0, warning: 1 };
        allIssues.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

        return {
            devices_analyzed: analyzed,
            total_issues: allIssues.length,
            critical_issues: allIssues.filter(i => i.severity === 'critical').length,
            warning_issues: allIssues.filter(i => i.severity === 'warning').length,
            issues: allIssues,
            prioritized_actions: allActions.slice(0, 10)
        };
    }

    async getIAQHealthScore(deviceId) {
        /**
         * Get an IAQ health score (0-100) with grade breakdown.
         *
         * Computed client-side from latest readings, mirroring
         * kukios-mcp-server scoring.
         *
         * @param {string} deviceId - Device UUID
         * @returns {Object} Health score with grade, message, per-parameter breakdown
         */
        const device = await this._findDevice(deviceId);
        if (!device) return { error: `Device not found: ${deviceId}` };

        const latest = await this._latestReading(deviceId);
        if (!latest) return { error: 'No readings available' };

        const paramScores = {};
        let totalScore = 0;
        let paramCount = 0;

        for (const [param, thresholds] of Object.entries(IAQ_THRESHOLDS)) {
            const value = latest[param];
            if (value === null || value === undefined) continue;
            const score = KukiOSClient._paramScore(value, thresholds);
            const status = score >= 80 ? '\u2705 Good'
                : score >= 50 ? '\u26a0\ufe0f Warning' : '\U0001F534 Critical';
            paramScores[param] = { score: Math.round(score), value, unit: thresholds.unit || '', status };
            totalScore += score;
            paramCount += 1;
        }

        const overall = paramCount ? Math.round(totalScore / paramCount) : 0;

        let grade, message;
        if (overall >= 90) { grade = 'A'; message = '\u2705 Excellent air quality!'; }
        else if (overall >= 75) { grade = 'B'; message = '\u26a0\ufe0f Good, but some areas need improvement'; }
        else if (overall >= 50) { grade = 'C'; message = '\u26a0\ufe0f Fair - Several issues need attention'; }
        else if (overall >= 25) { grade = 'D'; message = '\U0001F534 Poor - Immediate action required'; }
        else { grade = 'F'; message = '\U0001F6A8 Critical - Urgent intervention needed'; }

        return {
            device: device.name || 'Unknown',
            health_score: overall,
            grade,
            message,
            parameters: paramScores
        };
    }

    async compareToStandards(deviceId, standard = 'SS554') {
        /**
         * Compare latest readings against a named compliance standard.
         *
         * Fetches the standard's thresholds from /api/standards and evaluates
         * the device's latest readings client-side (the platform has no
         * per-device comparison endpoint).
         *
         * @param {string} deviceId - Device UUID
         * @param {string} [standard] - Standard code (SS554, RESET, WELL, GOAQS, WHO, ...)
         * @returns {Object} Compliance analysis with per-parameter details
         */
        const device = await this._findDevice(deviceId);
        if (!device) return { error: `Device not found: ${deviceId}` };

        let stdData = null;
        const available = [];
        try {
            for (const s of this._unwrapList(await this.listStandards())) {
                available.push(s.code || '');
                if (s.code === standard) stdData = s;
            }
        } catch { /* standards fetch failed */ }

        if (!stdData) {
            return {
                error: `Unknown standard: ${standard}. Available: ${
                    available.length ? available.join(', ') : 'SS554, RESET, WELL, GOAQS, WHO'}`
            };
        }

        const latest = await this._latestReading(deviceId);
        if (!latest) return { error: 'No readings available' };

        const thresholds = stdData.thresholds || {};
        const compliance = [];
        for (const [param, t] of Object.entries(thresholds)) {
            if (!t || typeof t !== 'object') continue;
            const value = latest[param];
            if (value === null || value === undefined) continue;
            const { good: goodVal, moderate: moderateVal, poor: poorVal, unit = '' } = t;
            if (goodVal === null || goodVal === undefined) continue;

            let compliant, limitStr;
            if (typeof goodVal === 'number') { compliant = value <= goodVal; limitStr = `<=${goodVal}`; }
            else { compliant = true; limitStr = String(goodVal); }

            let statusLabel, severity;
            if (compliant) { statusLabel = '\u2705 Compliant'; severity = 'good'; }
            else if (poorVal !== null && poorVal !== undefined && value > poorVal) { statusLabel = '\U0001F534 Poor'; severity = 'poor'; }
            else if (moderateVal !== null && moderateVal !== undefined && value > moderateVal) { statusLabel = '\u26a0\ufe0f Moderate'; severity = 'moderate'; }
            else { statusLabel = '\u26a0\ufe0f Above good'; severity = 'moderate'; }

            const detail = {
                parameter: param,
                value,
                unit,
                good_threshold: goodVal,
                moderate_threshold: moderateVal,
                poor_threshold: poorVal,
                compliant,
                severity,
                status: statusLabel
            };
            if (t.avg_period) detail.averaging_period = t.avg_period;
            compliance.push(detail);
        }

        const checked = compliance.length;
        const ok = compliance.filter(c => c.compliant).length;
        return {
            device: device.name || 'Unknown',
            standard,
            standard_name: stdData.name || standard,
            compliance_rate: checked ? `${ok}/${checked}` : 'N/A',
            fully_compliant: checked > 0 && ok === checked,
            parameters_checked: checked,
            details: compliance
        };
    }

    // ============================================================================
    // COMPLIANCE
    // ============================================================================

    async listStandards() {
        /**
         * List compliance standards.
         *
         * @returns {Object} Standards payload (list or {"data": [...]})
         */
        return this.get('/api/standards');
    }

    async calculateCompliance(deviceId, standardId, startTime, endTime) {
        /**
         * Calculate compliance server-side over a time window.
         *
         * POSTs to /api/compliance/calculate as the backend expects.
         *
         * @param {string} deviceId - Device UUID
         * @param {string} standardId - Standard UUID (from listStandards)
         * @param {string} startTime - Window start (ISO 8601)
         * @param {string} endTime - Window end (ISO 8601)
         * @returns {Object} Compliance calculation result
         */
        return this.post('/api/compliance/calculate', {
            sensorId: deviceId,
            standardId,
            startTime,
            endTime
        });
    }

    // ============================================================================
    // REPORTS
    // ============================================================================

    async listReports(page = 1, pageSize = 100) {
        /**
         * List reports.
         *
         * @param {number} [page] - Page number (1-based)
         * @param {number} [pageSize] - Items per page
         * @returns {Object} Reports payload
         */
        return this.get('/api/reports', { page, limit: pageSize });
    }

    async generateReportPDF(reportId) {
        /**
         * Generate a PDF for an existing report.
         *
         * @param {string} reportId - Report UUID (from listReports)
         * @returns {Object} PDF generation result
         */
        return this.post(`/api/reports/${reportId}/pdf`);
    }

    // ============================================================================
    // OPERATIONS
    // ============================================================================

    async healthCheck() {
        /** Platform health check (GET /health). */
        return this.get('/health');
    }

    async getRealtimeStatus() {
        /** Real-time system status (no cache). */
        return this.get('/api/operations/realtime');
    }

    async getSensorHistory(deviceId, hours = 24) {
        /**
         * Get sensor history.
         *
         * @param {string} deviceId - Sensor/device UUID
         * @param {number} [hours] - Hours of history (default 24)
         * @returns {Object} History data
         */
        return this.get(`/api/operations/sensors/${deviceId}/history`, { hours });
    }

    // ============================================================================
    // ALERTS
    // ============================================================================

    async listAlerts(status = null, severity = null, deviceId = null, buildingId = null, standardCode = null, page = 1, pageSize = 50) {
        /**
         * List IAQ alerts.
         *
         * @param {string} [status] - Filter by status (active, acknowledged, resolved)
         * @param {string} [severity] - Filter by severity (critical, warning, info)
         * @param {string} [deviceId] - Filter by device UUID
         * @param {string} [buildingId] - Filter by building UUID
         * @param {string} [standardCode] - Filter by standard code
         * @param {number} [page] - Page number (1-based, backend default 1)
         * @param {number} [pageSize] - Items per page (backend param is `limit`, default 50)
         * @returns {Object} Alerts payload
         */
        const params = { page, limit: pageSize };
        if (status) params.status = status;
        if (severity) params.severity = severity;
        if (deviceId) params.device_id = deviceId;
        if (buildingId) params.building_id = buildingId;
        if (standardCode) params.standard_code = standardCode;
        return this.get('/api/alerts', params);
    }

    async acknowledgeAlert(alertId, notes = '') {
        /**
         * Acknowledge alert.
         *
         * @param {string} alertId - Alert UUID
         * @param {string} [notes] - Optional acknowledgment notes
         * @returns {Object} Updated alert
         */
        return this.post(`/api/alerts/${alertId}/acknowledge`, notes ? { notes } : {});
    }

    async resolveAlert(alertId, resolution = '') {
        /**
         * Resolve alert.
         *
         * @param {string} alertId - Alert UUID
         * @param {string} [resolution] - Resolution notes (backend body field is `resolution`)
         * @returns {Object} Updated alert
         */
        return this.post(`/api/alerts/${alertId}/resolve`, resolution ? { resolution } : {});
    }
}

module.exports = {
    KukiOSClient,
    KukiOSAuthError,
    KukiOSAPIError,
    KukiOSConnectionError,
    KukiOSTimeoutError
};
