"""
KūkiOS MCP Client - Exceptions
"""


class KukiOSError(Exception):
    """Base exception for KūkiOS MCP Client"""
    pass


class KukiOSAuthError(KukiOSError):
    """Authentication error"""
    pass


class KukiOSAPIError(KukiOSError):
    """API error"""
    
    def __init__(self, message, status_code=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class KukiOSConnectionError(KukiOSError):
    """Connection error"""
    pass


class KukiOSTimeoutError(KukiOSConnectionError):
    """Request timeout error"""
    pass
