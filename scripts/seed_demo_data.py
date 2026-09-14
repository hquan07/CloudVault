#!/usr/bin/env python3
"""
CloudVault — Demo Seed Script
Creates sample users, uploads demo files, and generates share links
for portfolio demonstrations.

Usage:
    python scripts/seed_demo_data.py [--base-url http://localhost]
"""

import os
import sys
import json
import time
import argparse
import tempfile
import requests

# ── Configuration ──

DEFAULT_BASE = "http://localhost"
AUTH_URL = "{base}:8001/api/v1/auth"
FILE_URL = "{base}:8002/api/v1"
META_URL = "{base}:8003/api/v1"

DEMO_USERS = [
    {"email": "admin@cloudvault.dev", "username": "admin", "password": "Admin@2026!"},
    {"email": "alice@cloudvault.dev", "username": "alice", "password": "Alice@2026!"},
    {"email": "bob@cloudvault.dev", "username": "bob", "password": "Bob@2026!"},
]

DEMO_FILES = [
    {
        "name": "project-proposal.txt",
        "content": "CloudVault Project Proposal\n\nA modern personal cloud storage platform with microservices architecture.\n\nFeatures:\n- Unlimited object storage\n- Real-time search\n- Secure sharing\n- Activity tracking\n",
        "mime": "text/plain",
    },
    {
        "name": "meeting-notes.md",
        "content": "# Team Meeting Notes\n\n## Date: 2026-06-01\n\n### Agenda\n1. Sprint review\n2. Architecture decisions\n3. Next milestones\n\n### Decisions\n- Use Kafka for event streaming\n- MinIO for object storage\n- Elasticsearch for search\n",
        "mime": "text/markdown",
    },
    {
        "name": "config.json",
        "content": json.dumps(
            {
                "app": "cloudvault",
                "version": "1.0.0",
                "features": {"search": True, "sharing": True, "analytics": True},
            },
            indent=2,
        ),
        "mime": "application/json",
    },
    {
        "name": "readme.txt",
        "content": "Welcome to CloudVault!\n\nThis is a demo file to showcase the cloud storage capabilities.\nYou can upload, download, share, and search for files.\n\nVisit the dashboard to manage your files.\n",
        "mime": "text/plain",
    },
    {
        "name": "budget-2026.csv",
        "content": "Category,Q1,Q2,Q3,Q4\nInfrastructure,5000,5200,5500,6000\nDevelopment,15000,16000,17000,18000\nMarketing,3000,4000,5000,6000\nOperations,2000,2100,2200,2300\n",
        "mime": "text/csv",
    },
]


def log(emoji, msg):
    print(f"  {emoji} {msg}")


def create_users(base):
    """Register demo users."""
    url = AUTH_URL.format(base=base)
    tokens = {}

    for user in DEMO_USERS:
        try:
            r = requests.post(f"{url}/register", json=user, timeout=10)
            if r.status_code in (200, 201):
                data = r.json()
                token = (data.get("tokens") or {}).get("access_token") or data.get(
                    "access_token"
                )
                tokens[user["email"]] = token
                log("✅", f"Created user: {user['username']} ({user['email']})")
            elif r.status_code == 409 or "already" in r.text.lower():
                # User exists, login instead
                r2 = requests.post(
                    f"{url}/login",
                    json={"email": user["email"], "password": user["password"]},
                    timeout=10,
                )
                if r2.status_code == 200:
                    data2 = r2.json()
                    token = (data2.get("tokens") or {}).get(
                        "access_token"
                    ) or data2.get("access_token")
                    tokens[user["email"]] = token
                    log("🔄", f"User exists, logged in: {user['username']}")
        except Exception as e:
            log("❌", f"Error creating {user['username']}: {e}")

    return tokens

if __name__ == "__main__":
    create_users("http://localhost")