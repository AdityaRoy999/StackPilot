// ============================================================
// SourceArtifactController.cpp - immutable source archive API
// ============================================================

#include "SourceArtifactController.h"
#include "../db/Database.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <json/json.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>

namespace dokscp {
namespace {

std::string trim(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }
    return value.substr(start, end - start);
}

std::filesystem::path artifactRoot() {
    const char* env = std::getenv("SOURCE_ARTIFACT_DIR");
    if (env && *env) {
        return std::filesystem::path(env);
    }
    return std::filesystem::path("uploads/source-artifacts");
}

std::string sanitizeName(const std::string& raw) {
    std::string out;
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.';
        out.push_back(ok ? c : '-');
        if (out.size() >= 120) {
            break;
        }
    }
    return out.empty() ? "local-source" : out;
}

std::string base64Decode(const std::string& encoded) {
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new_mem_buf(encoded.data(), static_cast<int>(encoded.size()));
    bmem = BIO_push(b64, bmem);
    BIO_set_flags(bmem, BIO_FLAGS_BASE64_NO_NL);

    std::string decoded(encoded.size(), '\0');
    const int len = BIO_read(bmem, decoded.data(), static_cast<int>(decoded.size()));
    BIO_free_all(bmem);
    if (len <= 0) {
        return "";
    }
    decoded.resize(static_cast<size_t>(len));
    return decoded;
}

std::string sha256Hex(const std::string& bytes) {
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(), digest);
    std::ostringstream out;
    for (unsigned char b : digest) {
        out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(b);
    }
    return out.str();
}

Json::Value artifactRowToJson(const pqxx::row& row) {
    Json::Value artifact(Json::objectValue);
    artifact["id"] = row["id"].as<std::string>();
    artifact["name"] = row["name"].as<std::string>();
    artifact["sha256"] = row["sha256"].as<std::string>();
    artifact["size_bytes"] = static_cast<Json::Int64>(row["size_bytes"].as<long long>());
    artifact["file_count"] = row["file_count"].as<int>();
    artifact["source_root"] = row["source_root"].as<std::string>();
    artifact["source_kind"] = row["source_kind"].as<std::string>();
    artifact["created_at"] = row["created_at"].as<std::string>();
    return artifact;
}

} // namespace

std::string SourceArtifactController::extractUserId(const drogon::HttpRequestPtr& req) {
    auto payload = JwtHelper::verifyRequestToken(req);
    return payload.isNull() ? "" : payload["user_id"].asString();
}

void SourceArtifactController::createArtifact(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    auto body = req->getJsonObject();
    if (!body || !(*body).isMember("archive_base64") || !(*body)["archive_base64"].isString()) {
        Json::Value err; err["error"] = "archive_base64 is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp); return;
    }

    try {
        const std::string name = sanitizeName((*body).get("name", "local-source").asString());
        const int fileCount = (*body).get("file_count", 0).asInt();
        const std::string sourceRoot = trim((*body).get("source_root", "").asString());
        const std::string sourceKind = trim((*body).get("source_kind", "local_upload").asString()).empty()
            ? "local_upload"
            : trim((*body).get("source_kind", "local_upload").asString());
        const std::string archiveBytes = base64Decode((*body)["archive_base64"].asString());
        if (archiveBytes.empty()) {
            Json::Value err; err["error"] = "archive_base64 could not be decoded";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        const long long maxBytes = std::max<long long>(
            1,
            std::atoll(std::getenv("SOURCE_ARTIFACT_MAX_BYTES") ? std::getenv("SOURCE_ARTIFACT_MAX_BYTES") : "314572800")
        );
        if (static_cast<long long>(archiveBytes.size()) > maxBytes) {
            Json::Value err; err["error"] = "Source artifact is larger than the configured limit";
            err["max_bytes"] = static_cast<Json::Int64>(maxBytes);
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k413RequestEntityTooLarge);
            callback(resp); return;
        }

        const std::string sha = sha256Hex(archiveBytes);
        if ((*body).isMember("archive_sha256") && (*body)["archive_sha256"].isString() &&
            !(*body)["archive_sha256"].asString().empty() && (*body)["archive_sha256"].asString() != sha) {
            Json::Value err; err["error"] = "archive_sha256 does not match uploaded artifact";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto existingRows = txn.exec_params(
            "SELECT id, name, sha256, size_bytes, file_count, source_root, source_kind, created_at "
            "FROM source_artifacts WHERE user_id = $1 AND sha256 = $2",
            userId,
            sha
        );
        if (!existingRows.empty()) {
            txn.commit();
            Json::Value payload(Json::objectValue);
            payload["message"] = "Source artifact already exists";
            payload["artifact"] = artifactRowToJson(existingRows[0]);
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        const std::string artifactId = txn.exec1("SELECT gen_random_uuid()")[0].as<std::string>();
        const std::filesystem::path dir = artifactRoot() / userId;
        std::filesystem::create_directories(dir);
        const std::filesystem::path archivePath = dir / (artifactId + ".tar");

        {
            std::ofstream out(archivePath, std::ios::binary | std::ios::trunc);
            if (!out.is_open()) {
                throw std::runtime_error("Unable to write source artifact");
            }
            out.write(archiveBytes.data(), static_cast<std::streamsize>(archiveBytes.size()));
        }

        Json::Value metadata(Json::objectValue);
        if ((*body).isMember("metadata") && (*body)["metadata"].isObject()) {
            metadata = (*body)["metadata"];
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";

        auto rows = txn.exec_params(
            "INSERT INTO source_artifacts "
            "(id, user_id, name, storage_path, sha256, size_bytes, file_count, source_root, source_kind, metadata) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) "
            "RETURNING id, name, sha256, size_bytes, file_count, source_root, source_kind, created_at",
            artifactId,
            userId,
            name,
            archivePath.string(),
            sha,
            static_cast<long long>(archiveBytes.size()),
            fileCount,
            sourceRoot,
            sourceKind,
            Json::writeString(writer, metadata)
        );
        txn.commit();

        Json::Value payload(Json::objectValue);
        payload["message"] = "Source artifact uploaded";
        payload["artifact"] = artifactRowToJson(rows[0]);
        Json::Value auditMeta(Json::objectValue);
        auditMeta["name"] = name;
        auditMeta["sha256"] = sha;
        auditMeta["size_bytes"] = static_cast<Json::Int64>(archiveBytes.size());
        AuditLogger::recordFromRequest(req, userId, "source_artifact.created", "source_artifact", artifactId, auditMeta);
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Create source artifact error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SourceArtifactController::getArtifact(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, name, sha256, size_bytes, file_count, source_root, source_kind, created_at "
            "FROM source_artifacts WHERE id = $1 AND user_id = $2",
            id,
            userId
        );
        txn.commit();
        if (rows.empty()) {
            Json::Value err; err["error"] = "Source artifact not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        Json::Value payload(Json::objectValue);
        payload["artifact"] = artifactRowToJson(rows[0]);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Get source artifact error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

} // namespace dokscp
