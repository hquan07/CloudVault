#!/bin/sh
set -eu

export MYSQL_PWD="${MYSQL_ROOT_PASSWORD}"
mysql_args="--protocol=TCP -h mysql -u root ${MYSQL_DATABASE}"

mysql ${mysql_args} -e "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"

for migration in /migrations/*.sql; do
    version=$(basename "${migration}")
    applied=$(mysql ${mysql_args} -Nse "SELECT COUNT(*) FROM schema_migrations WHERE version = '${version}'")
    if [ "${applied}" = "0" ]; then
        echo "Applying ${version}"
        mysql ${mysql_args} < "${migration}"
        mysql ${mysql_args} -e "INSERT INTO schema_migrations (version) VALUES ('${version}')"
    fi
done
