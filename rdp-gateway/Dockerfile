FROM python:3.12-slim
WORKDIR /gateway
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install --timeout 120 --retries 4 -r requirements.txt
COPY app.py protocol.py ./
COPY schema.sql ./schema.sql
USER 65534:65534
EXPOSE 8095
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8095", "--no-access-log", "--log-level", "warning", "--ws-max-size", "262144", "--ws-max-queue", "8"]
