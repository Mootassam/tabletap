"""Where TableTap keeps its data.

Source checkout  -> ./data next to the code.
Installed copy   -> %LOCALAPPDATA%\\TableTap (an `.installed` marker sits next to the code).
TABLETAP_DATA env var overrides both (used by tests and server deployments).
"""
import os
import sys

APP_NAME = "TableTap"
APP_VERSION = "1.0.0"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")


def _data_dir():
    env = os.environ.get("TABLETAP_DATA")
    if env:
        return os.path.abspath(env)
    installed = getattr(sys, "frozen", False) or os.path.exists(os.path.join(BASE_DIR, ".installed"))
    if installed:
        root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(root, APP_NAME)
    return os.path.join(BASE_DIR, "data")


DATA_DIR = _data_dir()
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "tabletap.db")
SECRET_PATH = os.path.join(DATA_DIR, ".secret_key")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")

for _d in (DATA_DIR, UPLOAD_DIR, BACKUP_DIR):
    os.makedirs(_d, exist_ok=True)
