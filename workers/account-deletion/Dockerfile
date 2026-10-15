FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN chown -R 10001:0 /app && chmod -R g=u /app
USER 10001

EXPOSE 9101

CMD ["python", "-u", "main.py"]
