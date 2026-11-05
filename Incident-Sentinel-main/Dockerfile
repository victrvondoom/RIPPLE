FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt curl

COPY . .

EXPOSE 8090
CMD ["python", "mock_infrastructure.py"]
