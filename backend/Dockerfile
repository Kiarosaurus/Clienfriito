FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Production CMD: no --reload (dev-only; watchfiles churn + reload semantics).
# For live-editing in dev, docker-compose bind-mounts ./backend:/app — restart
# the container (docker compose restart backend) to pick up code changes.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
