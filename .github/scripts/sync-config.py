#!/usr/bin/env python3
"""Generate client configurations from sync-config.txt and Surge/Profile.conf.

Implementation lives in config_sync/; the CLI and template paths are unchanged.
"""
from config_sync.pipeline import main

if __name__ == "__main__":
    main()
