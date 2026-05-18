#include "ApplicationCatalog.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <stdexcept>

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

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string configString(const Json::Value& config, const ApplicationField& field) {
    std::string value = field.defaultValue;
    if (config.isObject() && config.isMember(field.id)) {
        if (config[field.id].isString()) {
            value = config[field.id].asString();
        } else if (config[field.id].isInt()) {
            value = std::to_string(config[field.id].asInt());
        } else if (config[field.id].isUInt()) {
            value = std::to_string(config[field.id].asUInt());
        } else if (config[field.id].isBool()) {
            value = config[field.id].asBool() ? "true" : "false";
        }
    }
    value = trim(value);
    if (field.required && value.empty()) {
        value = field.defaultValue;
    }
    if (field.type == "port") {
        try {
            int port = std::stoi(value);
            if (port < 1 || port > 65535) {
                value = field.defaultValue;
            }
        } catch (...) {
            value = field.defaultValue;
        }
    }
    return value;
}

std::string yamlQuote(const std::string& value) {
    std::string escaped = "'";
    for (char c : value) {
        if (c == '\'') {
            escaped += "''";
        } else {
            escaped.push_back(c);
        }
    }
    escaped += "'";
    return escaped;
}

std::string envRef(const std::string& key, const std::string& fallback) {
    return "${" + key + ":-" + fallback + "}";
}

std::string requiredEnvRef(const std::string& key) {
    return "${" + key + ":?Set " + key + "}";
}

std::string localPortMapping(const std::string& key, const std::string& fallback, const std::string& containerPort) {
    return "127.0.0.1:" + envRef(key, fallback) + ":" + containerPort;
}

std::string slug(std::string value) {
    value = lower(value);
    std::string out;
    char last = 0;
    for (char c : value) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        const char mapped = ok ? c : '-';
        if (mapped == '-' && last == '-') {
            continue;
        }
        out.push_back(mapped);
        last = mapped;
    }
    while (!out.empty() && out.front() == '-') out.erase(out.begin());
    while (!out.empty() && out.back() == '-') out.pop_back();
    return out.empty() ? "application" : out;
}

std::string composeFor(const ApplicationTemplate& tmpl) {
    const std::string s = tmpl.serviceName;
    if (tmpl.id == "postgres") {
        return
            "services:\n"
            "  " + s + ":\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    environment:\n"
            "      POSTGRES_DB: " + yamlQuote(envRef("POSTGRES_DB", "app")) + "\n"
            "      POSTGRES_USER: " + yamlQuote(envRef("POSTGRES_USER", "app")) + "\n"
            "      POSTGRES_PASSWORD: " + yamlQuote(requiredEnvRef("POSTGRES_PASSWORD")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "15432", "5432")) + "\n"
            "    volumes:\n"
            "      - postgres_data:/var/lib/postgresql/data\n"
            "    healthcheck:\n"
            "      test: [\"CMD-SHELL\", \"pg_isready -U \\\"$${POSTGRES_USER}\\\" -d \\\"$${POSTGRES_DB}\\\"\"]\n"
            "      interval: 10s\n"
            "      timeout: 5s\n"
            "      retries: 10\n"
            "volumes:\n"
            "  postgres_data:\n";
    }
    if (tmpl.id == "mysql" || tmpl.id == "mariadb") {
        return
            "services:\n"
            "  " + s + ":\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    environment:\n"
            "      MYSQL_DATABASE: " + yamlQuote(envRef("MYSQL_DATABASE", "app")) + "\n"
            "      MYSQL_USER: " + yamlQuote(envRef("MYSQL_USER", "app")) + "\n"
            "      MYSQL_PASSWORD: " + yamlQuote(requiredEnvRef("MYSQL_PASSWORD")) + "\n"
            "      MYSQL_ROOT_PASSWORD: " + yamlQuote(requiredEnvRef("MYSQL_ROOT_PASSWORD")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", tmpl.id == "mariadb" ? "13307" : "13306", "3306")) + "\n"
            "    volumes:\n"
            "      - db_data:/var/lib/mysql\n"
            "volumes:\n"
            "  db_data:\n";
    }
    if (tmpl.id == "redis") {
        return
            "services:\n"
            "  redis:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    command: [\"sh\", \"-c\", \"redis-server --appendonly yes --requirepass \\\"$${REDIS_PASSWORD}\\\"\"]\n"
            "    environment:\n"
            "      REDIS_PASSWORD: " + yamlQuote(requiredEnvRef("REDIS_PASSWORD")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "16379", "6379")) + "\n"
            "    volumes:\n"
            "      - redis_data:/data\n"
            "volumes:\n"
            "  redis_data:\n";
    }
    if (tmpl.id == "mongo") {
        return
            "services:\n"
            "  mongo:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    environment:\n"
            "      MONGO_INITDB_ROOT_USERNAME: " + yamlQuote(envRef("MONGO_INITDB_ROOT_USERNAME", "admin")) + "\n"
            "      MONGO_INITDB_ROOT_PASSWORD: " + yamlQuote(requiredEnvRef("MONGO_INITDB_ROOT_PASSWORD")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "27018", "27017")) + "\n"
            "    volumes:\n"
            "      - mongo_data:/data/db\n"
            "volumes:\n"
            "  mongo_data:\n";
    }
    if (tmpl.id == "rabbitmq") {
        return
            "services:\n"
            "  rabbitmq:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    environment:\n"
            "      RABBITMQ_DEFAULT_USER: " + yamlQuote(envRef("RABBITMQ_DEFAULT_USER", "admin")) + "\n"
            "      RABBITMQ_DEFAULT_PASS: " + yamlQuote(requiredEnvRef("RABBITMQ_DEFAULT_PASS")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "15672", "5672")) + "\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_UI_PORT", "15673", "15672")) + "\n"
            "    volumes:\n"
            "      - rabbitmq_data:/var/lib/rabbitmq\n"
            "volumes:\n"
            "  rabbitmq_data:\n";
    }
    if (tmpl.id == "minio") {
        return
            "services:\n"
            "  minio:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    command: [\"server\", \"/data\", \"--console-address\", \":9001\"]\n"
            "    environment:\n"
            "      MINIO_ROOT_USER: " + yamlQuote(envRef("MINIO_ROOT_USER", "minioadmin")) + "\n"
            "      MINIO_ROOT_PASSWORD: " + yamlQuote(requiredEnvRef("MINIO_ROOT_PASSWORD")) + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "19000", "9000")) + "\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_UI_PORT", "19001", "9001")) + "\n"
            "    volumes:\n"
            "      - minio_data:/data\n"
            "volumes:\n"
            "  minio_data:\n";
    }
    if (tmpl.id == "grafana") {
        return
            "services:\n"
            "  grafana:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    environment:\n"
            "      GF_SECURITY_ADMIN_USER: " + yamlQuote(envRef("GF_SECURITY_ADMIN_USER", "admin")) + "\n"
            "      GF_SECURITY_ADMIN_PASSWORD: " + yamlQuote(requiredEnvRef("GF_SECURITY_ADMIN_PASSWORD")) + "\n"
            "      GF_USERS_ALLOW_SIGN_UP: " + yamlQuote("false") + "\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "13000", "3000")) + "\n"
            "    volumes:\n"
            "      - grafana_data:/var/lib/grafana\n"
            "volumes:\n"
            "  grafana_data:\n";
    }
    if (tmpl.id == "prometheus") {
        return
            "services:\n"
            "  prometheus:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "19090", "9090")) + "\n"
            "    volumes:\n"
            "      - prometheus_data:/prometheus\n"
            "volumes:\n"
            "  prometheus_data:\n";
    }
    if (tmpl.id == "adminer") {
        return
            "services:\n"
            "  adminer:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "18080", "8080")) + "\n";
    }
    if (tmpl.id == "nginx") {
        return
            "services:\n"
            "  nginx:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "8088", "80")) + "\n";
    }
    if (tmpl.id == "nats") {
        return
            "services:\n"
            "  nats:\n"
            "    image: " + tmpl.image + "\n"
            "    restart: unless-stopped\n"
            "    command: [\"-js\", \"-sd\", \"/data\", \"-m\", \"8222\"]\n"
            "    ports:\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_PORT", "14222", "4222")) + "\n"
            "      - " + yamlQuote(localPortMapping("APP_PUBLIC_UI_PORT", "18222", "8222")) + "\n"
            "    volumes:\n"
            "      - nats_data:/data\n"
            "volumes:\n"
            "  nats_data:\n";
    }
    throw std::runtime_error("Unsupported application template");
}

ApplicationField portField(const std::string& fallback) {
    return {"public_port", "Public port", "port", "APP_PUBLIC_PORT", fallback, false, true};
}

ApplicationField uiPortField(const std::string& fallback) {
    return {"public_ui_port", "Public UI port", "port", "APP_PUBLIC_UI_PORT", fallback, false, true};
}

} // namespace

std::vector<ApplicationTemplate> ApplicationCatalog::templates() {
    return {
        {"postgres", "PostgreSQL", "Databases", "Reliable relational database for production apps.", "postgres", "postgres:16-alpine", 5432,
            {portField("15432"), {"database", "Database", "text", "POSTGRES_DB", "app", false, true}, {"username", "Username", "text", "POSTGRES_USER", "app", false, true}, {"password", "Password", "password", "POSTGRES_PASSWORD", "", true, true}}},
        {"mysql", "MySQL", "Databases", "Popular relational database with persistent storage.", "mysql", "mysql:8.4", 3306,
            {portField("13306"), {"database", "Database", "text", "MYSQL_DATABASE", "app", false, true}, {"username", "Username", "text", "MYSQL_USER", "app", false, true}, {"password", "Password", "password", "MYSQL_PASSWORD", "", true, true}, {"root_password", "Root password", "password", "MYSQL_ROOT_PASSWORD", "", true, true}}},
        {"mariadb", "MariaDB", "Databases", "MySQL-compatible open source relational database.", "mariadb", "mariadb:11", 3306,
            {portField("13307"), {"database", "Database", "text", "MYSQL_DATABASE", "app", false, true}, {"username", "Username", "text", "MYSQL_USER", "app", false, true}, {"password", "Password", "password", "MYSQL_PASSWORD", "", true, true}, {"root_password", "Root password", "password", "MYSQL_ROOT_PASSWORD", "", true, true}}},
        {"redis", "Redis", "Cache", "In-memory cache and queue backend with persistence.", "redis", "redis:7-alpine", 6379,
            {portField("16379"), {"password", "Password", "password", "REDIS_PASSWORD", "", true, true}}},
        {"mongo", "MongoDB", "Databases", "Document database with a root administrator account.", "mongo", "mongo:7", 27017,
            {portField("27018"), {"username", "Root username", "text", "MONGO_INITDB_ROOT_USERNAME", "admin", false, true}, {"password", "Root password", "password", "MONGO_INITDB_ROOT_PASSWORD", "", true, true}}},
        {"rabbitmq", "RabbitMQ", "Queues", "Message broker with the management UI enabled.", "rabbitmq", "rabbitmq:3-management-alpine", 5672,
            {portField("15672"), uiPortField("15673"), {"username", "Username", "text", "RABBITMQ_DEFAULT_USER", "admin", false, true}, {"password", "Password", "password", "RABBITMQ_DEFAULT_PASS", "", true, true}}},
        {"nats", "NATS", "Queues", "Lightweight messaging server with JetStream enabled.", "nats", "nats:2-alpine", 4222,
            {portField("14222"), uiPortField("18222")}},
        {"minio", "MinIO", "Storage", "S3-compatible object storage with browser console.", "minio", "minio/minio:latest", 9000,
            {portField("19000"), uiPortField("19001"), {"username", "Root user", "text", "MINIO_ROOT_USER", "minioadmin", false, true}, {"password", "Root password", "password", "MINIO_ROOT_PASSWORD", "", true, true}}},
        {"grafana", "Grafana", "Monitoring", "Dashboards and observability UI.", "grafana", "grafana/grafana-oss:11.5.2", 3000,
            {portField("13000"), {"username", "Admin user", "text", "GF_SECURITY_ADMIN_USER", "admin", false, true}, {"password", "Admin password", "password", "GF_SECURITY_ADMIN_PASSWORD", "", true, true}}},
        {"prometheus", "Prometheus", "Monitoring", "Metrics collection and query engine.", "prometheus", "prom/prometheus:v2.55.1", 9090,
            {portField("19090")}},
        {"adminer", "Adminer", "Utilities", "Single-container database administration UI.", "adminer", "adminer:latest", 8080,
            {portField("18080")}},
        {"nginx", "Nginx", "Web", "Static web server and reverse proxy starter.", "nginx", "nginx:alpine", 80,
            {portField("8088")}}
    };
}

const ApplicationTemplate* ApplicationCatalog::findTemplate(const std::string& templateId) {
    static const std::vector<ApplicationTemplate> items = templates();
    for (const auto& item : items) {
        if (item.id == templateId) {
            return &item;
        }
    }
    return nullptr;
}

bool ApplicationCatalog::isSupportedTemplate(const std::string& templateId) {
    return findTemplate(templateId) != nullptr;
}

Json::Value ApplicationCatalog::templatesJson() {
    Json::Value items(Json::arrayValue);
    for (const auto& tmpl : templates()) {
        Json::Value item(Json::objectValue);
        item["id"] = tmpl.id;
        item["name"] = tmpl.name;
        item["category"] = tmpl.category;
        item["description"] = tmpl.description;
        item["image"] = tmpl.image;
        item["primary_port"] = tmpl.primaryPort;
        item["fields"] = Json::Value(Json::arrayValue);
        for (const auto& field : tmpl.fields) {
            Json::Value fieldJson(Json::objectValue);
            fieldJson["id"] = field.id;
            fieldJson["label"] = field.label;
            fieldJson["type"] = field.type;
            fieldJson["env_key"] = field.envKey;
            fieldJson["default"] = field.defaultValue;
            fieldJson["secret"] = field.secret;
            fieldJson["required"] = field.required;
            item["fields"].append(fieldJson);
        }
        items.append(item);
    }
    return items;
}

Json::Value ApplicationCatalog::sanitizedConfig(const std::string& templateId, const Json::Value& config) {
    const auto* tmpl = findTemplate(templateId);
    if (!tmpl) {
        return Json::Value(Json::objectValue);
    }
    Json::Value out(Json::objectValue);
    out["template_id"] = tmpl->id;
    out["template_name"] = tmpl->name;
    out["image"] = tmpl->image;
    out["fields"] = Json::Value(Json::objectValue);
    for (const auto& field : tmpl->fields) {
        Json::Value fieldState(Json::objectValue);
        fieldState["env_key"] = field.envKey;
        fieldState["configured"] = !configString(config, field).empty();
        if (!field.secret) {
            fieldState["value"] = configString(config, field);
        }
        out["fields"][field.id] = fieldState;
    }
    return out;
}

std::vector<std::string> ApplicationCatalog::missingRequiredFields(const std::string& templateId, const Json::Value& config) {
    std::vector<std::string> missing;
    const auto* tmpl = findTemplate(templateId);
    if (!tmpl) {
        return missing;
    }
    for (const auto& field : tmpl->fields) {
        if (field.required && configString(config, field).empty()) {
            missing.push_back(field.label);
        }
    }
    return missing;
}

std::vector<BuildEnvVar> ApplicationCatalog::envVarsForConfig(const std::string& templateId, const Json::Value& config) {
    std::vector<BuildEnvVar> envVars;
    const auto* tmpl = findTemplate(templateId);
    if (!tmpl) {
        return envVars;
    }
    for (const auto& field : tmpl->fields) {
        const std::string value = configString(config, field);
        if (!field.envKey.empty() && !value.empty()) {
            envVars.push_back({field.envKey, value});
        }
    }
    return envVars;
}

std::filesystem::path ApplicationCatalog::materializeSource(const std::string& deploymentId,
                                                            const std::string& projectName,
                                                            const std::string& templateId,
                                                            const Json::Value& config,
                                                            const std::filesystem::path& baseDir) {
    const auto* tmpl = findTemplate(templateId);
    if (!tmpl) {
        throw std::runtime_error("Unsupported application template");
    }
    const auto sourceDir = baseDir / ("dokscp-application-" + slug(projectName) + "-" + slug(deploymentId));
    std::error_code ec;
    std::filesystem::remove_all(sourceDir, ec);
    std::filesystem::create_directories(sourceDir, ec);
    if (ec) {
        throw std::runtime_error("Unable to create generated application source directory");
    }

    {
        std::ofstream compose(sourceDir / "docker-compose.prod.yml", std::ios::trunc);
        compose << composeFor(*tmpl);
    }
    {
        std::ofstream readme(sourceDir / "README.md", std::ios::trunc);
        readme << "# " << tmpl->name << "\n\n"
               << "Generated by DOKSCP Application source.\n\n"
               << "- Template: " << tmpl->id << "\n"
               << "- Image: " << tmpl->image << "\n";
        Json::Value safe = sanitizedConfig(templateId, config);
        if (safe.isObject() && safe.isMember("fields")) {
            readme << "- Configuration is supplied through encrypted DOKSCP environment variables.\n";
        }
    }
    return sourceDir;
}

} // namespace dokscp
