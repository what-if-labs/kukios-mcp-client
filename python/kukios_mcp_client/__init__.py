"""
KūkiOS MCP Client - Python Library

Official client library for connecting to KūkiOS IAQ Monitoring Platform via MCP.
"""

from .client import KukiOSClient
from .exceptions import (
    KukiOSAuthError,
    KukiOSAPIError,
    KukiOSConnectionError,
    KukiOSError
)

__version__ = "1.0.0"
__author__ = "What If Labs"
__email__ = "kuki@what-if.sg"

__all__ = [
    "KukiOSClient",
    "KukiOSAuthError",
    "KukiOSAPIError",
    "KukiOSConnectionError",
    "KukiOSError"
]
