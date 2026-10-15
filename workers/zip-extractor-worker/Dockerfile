FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc default-libmysqlclient-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY workers/zip-extractor-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY workers/common ./common
COPY workers/zip-extractor-worker/main.py .
RUN chown -R 10001:0 /app && chmod -R g=u /app
USER 10001
CMD ["python", "-u", "main.py"]
