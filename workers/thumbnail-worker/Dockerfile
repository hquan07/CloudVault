FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc default-libmysqlclient-dev pkg-config libjpeg-dev ffmpeg && rm -rf /var/lib/apt/lists/*
COPY workers/thumbnail-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY workers/common ./common
COPY workers/thumbnail-worker/main.py .
CMD ["python", "-u", "main.py"]
