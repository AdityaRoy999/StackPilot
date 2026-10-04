FROM python:3.12-slim
RUN pip install --no-cache-dir fastapi==0.115.12 uvicorn==0.34.2 httpx==0.28.1 websockets==15.0.1 psycopg2-binary==2.9.10
WORKDIR /gateway
COPY app.py ./app.py
USER 65534:65534
EXPOSE 8091
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--no-access-log"]
