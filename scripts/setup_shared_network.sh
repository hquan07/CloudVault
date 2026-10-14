#!/bin/sh
set -eu

network_name="cloudvault-shared"

if docker network inspect "${network_name}" >/dev/null 2>&1; then
    echo "Docker network ${network_name} already exists."
else
    docker network create --driver bridge "${network_name}" >/dev/null
    echo "Created Docker network ${network_name}."
fi
