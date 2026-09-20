"""Plugins: every capability that is not the backbone itself.

Third parties add their own by subclassing Plugin and calling register();
importing the module is enough to make the name usable in a config file.
"""

from .base import Plugin, available, build, fire, get, register

__all__ = ["Plugin", "available", "build", "fire", "get", "register"]
