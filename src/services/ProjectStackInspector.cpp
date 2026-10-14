#include "ProjectStackInspector.h"
#include "../utils/StringUtils.h"
#include <curl/curl.h>
#include <drogon/utils/Utilities.h>
#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <future>
#include <regex>
#include <set>
#include <sstream>
#include <vector>

namespace stackpilot {
namespace {
constexpr size_t maxFiles = 24, maxFileBytes = 65536, maxTotalBytes = 524288;
const std::set<std::string> names = {
    "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml",
    "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "CMakeLists.txt",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "schema.prisma"
};
const std::set<std::string> ignored = {
    ".git", "node_modules", ".next", ".venv", "venv", "vendor", "dist", "build", "target", ".cache", "coverage"
};
Json::Value parse(const std::string& value) {
    Json::Value parsed; Json::CharReaderBuilder builder; std::string error;
    std::istringstream stream(value);
    if (!Json::parseFromStream(builder, stream, &parsed, &error)) return Json::Value();
    return parsed;
}
void add(Json::Value& result, const std::string& id, const std::string& name,
         const std::string& role, const std::string& kind, const std::string& evidence) {
    for (auto& item : result["components"]) {
        if (item["id"].asString() == id && item["kind"].asString() == kind) {
            if (item["evidence"].size() < 8) {
                bool exists = false;
                for (const auto& path : item["evidence"]) exists |= path.asString() == evidence;
                if (!exists) item["evidence"].append(evidence);
            }
            return;
        }
    }
    if (result["components"].size() >= 32) { result["truncated"] = true; return; }
    Json::Value item; item["id"] = id; item["name"] = name; item["role"] = role; item["kind"] = kind;
    item["evidence"] = Json::arrayValue; item["evidence"].append(evidence);
    result["components"].append(item);
}
void image(Json::Value& result, std::string value, const std::string& evidence) {
    value = strings::toLower(strings::trim(value));
    if (!std::regex_match(value, std::regex("[a-z0-9][a-z0-9._/:@-]*"))) return;
    auto base = value.substr(value.find_last_of('/') == std::string::npos ? 0 : value.find_last_of('/') + 1);
    base = base.substr(0, base.find_first_of(":@"));
    struct Image { const char* id; const char* name; const char* role; };
    const Image images[] = {{"postgres", "PostgreSQL", "database"}, {"mysql", "MySQL", "database"},
        {"mariadb", "MariaDB", "database"}, {"mongo", "MongoDB", "database"}, {"redis", "Redis", "cache"},
        {"valkey", "Valkey", "cache"}, {"rabbitmq", "RabbitMQ", "queue"}, {"nginx", "Nginx", "infrastructure"},
        {"caddy", "Caddy", "infrastructure"}, {"minio", "MinIO", "storage"}, {"neo4j", "Neo4j", "database"},
        {"clickhouse-server", "ClickHouse", "database"}, {"prometheus", "Prometheus", "monitoring"},
        {"grafana", "Grafana", "monitoring"}, {"loki", "Loki", "monitoring"}};
    for (const auto& entry : images) if (base == entry.id) add(result, entry.id, entry.name, entry.role, "service", evidence);
    if (base == "node") add(result, "node", "Node.js", "runtime", "runtime", evidence);
    if (base == "python") add(result, "python", "Python", "runtime", "runtime", evidence);
    if (base == "golang") add(result, "go", "Go", "runtime", "runtime", evidence);
    if (base == "rust") add(result, "rust", "Rust", "runtime", "runtime", evidence);
    if (base == "openjdk" || base == "eclipse-temurin") add(result, "java", "Java", "runtime", "runtime", evidence);
}
struct HttpBody { std::string text; size_t limit; };
size_t receive(char* data, size_t size, size_t count, void* ptr) {
    auto& buffer = *static_cast<HttpBody*>(ptr);
    if (count && size > buffer.limit / count) return 0;
    size_t length = size * count;
    if (buffer.text.size() + length > buffer.limit) return 0;
    buffer.text.append(data, length); return length;
}
Json::Value githubRequest(const std::string& path, const std::string& token, size_t limit = 4194304) {
    CURL* handle = curl_easy_init();
    if (!handle) return Json::Value();
    const std::string url = "https://api.github.com" + path;
    HttpBody body{"", limit};
    curl_slist* headers = curl_slist_append(nullptr, "Accept: application/vnd.github+json");
    if (!token.empty()) headers = curl_slist_append(headers, ("Authorization: Bearer " + token).c_str());
    curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(handle, CURLOPT_USERAGENT, "StackPilot-stack-inspector");
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, 3L);
    curl_easy_setopt(handle, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(handle, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &body);
    auto code = curl_easy_perform(handle); long status = 0;
    curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers); curl_easy_cleanup(handle);
    return code == CURLE_OK && status == 200 ? parse(body.text) : Json::Value();
}
std::string encode(const std::string& value) { return drogon::utils::urlEncode(value); }
}

bool ProjectStackInspector::isManifest(const std::string& path) {
    if (path.empty() || path.size() > 512 || path.find('\n') != std::string::npos || path.find('\r') != std::string::npos) return false;
    const auto clean = std::filesystem::path(path).lexically_normal();
    if (clean.is_absolute()) return false;
    for (const auto& part : clean) if (part == ".." || ignored.count(part.string())) return false;
    const auto name = clean.filename().string();
    return names.count(name) || clean.extension() == ".csproj";
}

Json::Value ProjectStackInspector::unavailable(const std::string& message) {
    Json::Value result; result["status"] = "unavailable"; result["message"] = message;
    result["components"] = Json::arrayValue; result["manifests"] = Json::arrayValue;
    result["files_scanned"] = 0; result["truncated"] = false; result["method"] = "manifests";
    result["inspected_at"] = static_cast<Json::Int64>(std::time(nullptr));
    return result;
}

Json::Value ProjectStackInspector::detect(const Manifests& files, bool truncated) {
    auto result = unavailable(""); result["truncated"] = truncated;
    size_t total = 0;
    for (const auto& [path, content] : files) {
        if (!isManifest(path)) continue;
        if (result["manifests"].size() >= maxFiles || content.size() > maxFileBytes || total + content.size() > maxTotalBytes) {
            result["truncated"] = true; continue;
        }
        total += content.size(); result["manifests"].append(path);
        const auto file = std::filesystem::path(path).filename().string();
        auto lowered = strings::toLower(content);
        if (file == "package.json") {
            auto package = parse(content);
            if (!package.isObject()) { result["truncated"] = true; continue; }
            add(result, "node", "Node.js", "runtime", "runtime", path);
            auto deps = package["dependencies"].isObject() ? package["dependencies"] : Json::Value(Json::objectValue);
            if (package["devDependencies"].isObject()) for (const auto& key : package["devDependencies"].getMemberNames()) deps[key] = package["devDependencies"][key];
            struct Dependency { const char* key; const char* id; const char* name; const char* role; const char* kind; };
            const Dependency known[] = {
                {"next", "nextjs", "Next.js", "frontend", "framework"}, {"react", "react", "React", "frontend", "framework"},
                {"vue", "vue", "Vue", "frontend", "framework"}, {"nuxt", "nuxt", "Nuxt", "frontend", "framework"},
                {"svelte", "svelte", "Svelte", "frontend", "framework"}, {"@angular/core", "angular", "Angular", "frontend", "framework"},
                {"astro", "astro", "Astro", "frontend", "framework"}, {"express", "express", "Express", "backend", "framework"},
                {"fastify", "fastify", "Fastify", "backend", "framework"}, {"@nestjs/core", "nestjs", "NestJS", "backend", "framework"},
                {"hono", "hono", "Hono", "backend", "framework"}, {"koa", "koa", "Koa", "backend", "framework"},
                {"pg", "postgres", "PostgreSQL", "database", "client"}, {"postgres", "postgres", "PostgreSQL", "database", "client"},
                {"mysql2", "mysql", "MySQL", "database", "client"}, {"mongodb", "mongo", "MongoDB", "database", "client"},
                {"mongoose", "mongo", "MongoDB", "database", "client"}, {"redis", "redis", "Redis", "cache", "client"},
                {"ioredis", "redis", "Redis", "cache", "client"}, {"better-sqlite3", "sqlite", "SQLite", "database", "client"},
                {"sqlite3", "sqlite", "SQLite", "database", "client"}, {"@prisma/client", "prisma", "Prisma", "database", "client"},
                {"@supabase/supabase-js", "supabase", "Supabase", "database", "client"}, {"amqplib", "rabbitmq", "RabbitMQ", "queue", "client"}};
            for (const auto& entry : known) if (deps.isMember(entry.key)) add(result, entry.id, entry.name, entry.role, entry.kind, path);
        }
        auto dependency = [&](const std::string& key) {
            const auto declarations = std::regex_replace(lowered, std::regex("#[^\\n\\r]*"), "");
            return std::regex_search(declarations, std::regex("(?:^|\\n)\\s*" + key + "(?:\\s*[=<>~!:\\[]|[\\t ]*(?:\\r?\\n|$))|[\"']" + key + "(?:[=<>~!\\[]|[\"'])"));
        };
        if (file == "requirements.txt" || file == "pyproject.toml" || file == "Pipfile") {
            add(result, "python", "Python", "runtime", "runtime", path);
            for (const auto& entry : std::vector<std::pair<std::string, std::string>>{{"django","Django"},{"flask","Flask"},{"fastapi","FastAPI"},{"starlette","Starlette"}})
                if (dependency(entry.first)) add(result, entry.first, entry.second, "backend", "framework", path);
            for (const auto& entry : std::vector<std::pair<std::string, std::string>>{{"psycopg","PostgreSQL"},{"psycopg2","PostgreSQL"},{"psycopg2-binary","PostgreSQL"},{"asyncpg","PostgreSQL"},{"pymongo","MongoDB"},{"redis","Redis"},{"pymysql","MySQL"}})
                if (dependency(entry.first)) add(result, entry.second == "PostgreSQL" ? "postgres" : entry.second == "MongoDB" ? "mongo" : entry.second == "MySQL" ? "mysql" : "redis", entry.second, entry.second == "Redis" ? "cache" : "database", "client", path);
        }
        if (file == "go.mod") { add(result, "go", "Go", "runtime", "runtime", path); if (lowered.find("gin-gonic/gin") != std::string::npos) add(result, "gin", "Gin", "backend", "framework", path); }
        if (file == "Cargo.toml") { add(result, "rust", "Rust", "runtime", "runtime", path); if (dependency("axum")) add(result, "axum", "Axum", "backend", "framework", path); if (dependency("actix-web")) add(result, "actix", "Actix Web", "backend", "framework", path); }
        if (file == "pom.xml" || file == "build.gradle" || file == "build.gradle.kts") {
            add(result, "java", "Java", "runtime", "runtime", path);
            if (lowered.find("org.springframework.boot") != std::string::npos) add(result, "spring", "Spring Boot", "backend", "framework", path);
        }
        if (file == "composer.json") { add(result, "php", "PHP", "runtime", "runtime", path); auto package = parse(content); if (package.isObject() && package["require"].isObject() && package["require"].isMember("laravel/framework")) add(result, "laravel", "Laravel", "backend", "framework", path); }
        if (file == "Gemfile") { add(result, "ruby", "Ruby", "runtime", "runtime", path); if (std::regex_search(lowered, std::regex("gem\\s+['\"]rails['\"]"))) add(result, "rails", "Rails", "backend", "framework", path); }
        if (file == "CMakeLists.txt") { add(result, "cpp", "C/C++", "runtime", "runtime", path); if (lowered.find("find_package(drogon") != std::string::npos) add(result, "drogon", "Drogon", "backend", "framework", path); }
        if (std::filesystem::path(path).extension() == ".csproj") { add(result, "dotnet", ".NET", "runtime", "runtime", path); if (lowered.find("microsoft.net.sdk.web") != std::string::npos) add(result, "aspnet", "ASP.NET", "backend", "framework", path); }
        if (file == "schema.prisma") {
            std::regex provider("provider\\s*=\\s*\"(postgresql|mysql|sqlite|mongodb)\""); std::smatch match;
            if (std::regex_search(lowered, match, provider)) {
                const auto key = match[1].str(); add(result, key == "postgresql" ? "postgres" : key == "mongodb" ? "mongo" : key,
                    key == "postgresql" ? "PostgreSQL" : key == "mongodb" ? "MongoDB" : key == "mysql" ? "MySQL" : "SQLite", "database", "client", path);
            }
        }
        if (file == "Dockerfile" || file.find("compose.") != std::string::npos) {
            add(result, "docker", "Docker", "infrastructure", "configuration", path);
            const std::regex pattern(file == "Dockerfile" ? "(?:^|\\n)\\s*FROM\\s+(?:--platform=\\S+\\s+)?([^\\s]+)" : "(?:^|\\n)\\s*image\\s*:\\s*['\"]?([a-zA-Z0-9][a-zA-Z0-9._/:@-]*)");
            for (auto it = std::sregex_iterator(content.begin(), content.end(), pattern); it != std::sregex_iterator(); ++it) image(result, (*it)[1].str(), path);
        }
    }
    result["files_scanned"] = result["manifests"].size();
    result["status"] = result["components"].empty() ? "unknown" : "detected";
    result["message"] = result["components"].empty() ? "No supported stack manifests found. You can still create the project." : "Detected from source manifests; database clients do not provision a database.";
    if (result["truncated"].asBool()) result["message"] = "Partial inspection: some files were outside the scan limits or could not be read.";
    return result;
}

Json::Value ProjectStackInspector::application(const std::string& configuredImage) {
    auto result = detect({}); result["method"] = "application";
    image(result, configuredImage, "Configured application image");
    if (result["components"].empty()) add(result, "container", "Application container", "application", "service", "Configured application image");
    result["status"] = "detected"; result["message"] = "Declared application image; running service health is shown separately.";
    return result;
}

Json::Value ProjectStackInspector::local(const std::filesystem::path& root) {
    namespace fs = std::filesystem; Manifests files; std::error_code ec; size_t scanned = 0, total = 0; bool truncated = false;
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec), end;
    while (!ec && it != end) {
        const auto entry = *it; const auto name = entry.path().filename().string();
        if (entry.is_symlink(ec) || (entry.is_directory(ec) && (ignored.count(name) || it.depth() >= 5))) it.disable_recursion_pending();
        else if (entry.is_regular_file(ec)) {
            auto relative = entry.path().lexically_relative(root).generic_string();
            if (isManifest(relative)) {
                auto size = entry.file_size(ec);
                if (!ec && size <= maxFileBytes && total + size <= maxTotalBytes) {
                    std::ifstream stream(entry.path(), std::ios::binary); std::string content(static_cast<size_t>(size), '\0');
                    stream.read(content.data(), content.size());
                    if (stream && static_cast<size_t>(stream.gcount()) == size) { files[relative] = content; total += size; }
                    else truncated = true;
                } else truncated = true;
            }
        }
        if (++scanned >= 4000 || files.size() >= maxFiles) { truncated = true; break; }
        ec.clear(); it.increment(ec);
    }
    return detect(files, truncated || bool(ec));
}

Json::Value ProjectStackInspector::github(const std::string& repositoryUrl, const std::string& token, const std::string& branch) {
    std::smatch match;
    if (!std::regex_match(repositoryUrl, match, std::regex("(?:https://github\\.com/|git@github\\.com:)([A-Za-z0-9_-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?/?")))
        return unavailable("Enter a valid GitHub repository URL to inspect its stack.");
    const auto repository = match[1].str();
    const auto tree = githubRequest("/repos/" + repository + "/git/trees/" + encode(branch.empty() ? "HEAD" : branch) + "?recursive=1", token);
    if (!tree["tree"].isArray()) return unavailable("Source could not be inspected. Check repository access, branch, or GitHub rate limits; project creation is still available.");
    std::vector<std::pair<std::string, std::string>> manifests; bool truncated = tree["truncated"].asBool();
    for (const auto& item : tree["tree"]) {
        const auto path = item["path"].asString();
        if (item["type"].asString() != "blob" || item["mode"].asString() == "120000" || !isManifest(path)) continue;
        if (item["size"].asUInt64() > maxFileBytes) { truncated = true; continue; }
        manifests.emplace_back(path, item["sha"].asString());
    }
    std::sort(manifests.begin(), manifests.end(), [](const auto& a, const auto& b) {
        auto depth = [](const auto& path) { return std::count(path.begin(), path.end(), '/'); };
        return depth(a.first) != depth(b.first) ? depth(a.first) < depth(b.first) : a.first < b.first;
    });
    if (manifests.size() > maxFiles) { manifests.resize(maxFiles); truncated = true; }
    Manifests files; const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(12);
    for (size_t index = 0; index < manifests.size(); index += 4) {
        if (std::chrono::steady_clock::now() >= deadline) { truncated = true; break; }
        std::vector<std::future<std::pair<std::string, std::string>>> reads;
        for (size_t j = index; j < std::min(index + 4, manifests.size()); ++j) reads.push_back(std::async(std::launch::async, [&, j] {
            const auto data = githubRequest("/repos/" + repository + "/git/blobs/" + manifests[j].second, token, 131072);
            if (data["encoding"].asString() != "base64") return std::make_pair(manifests[j].first, std::string());
            return std::make_pair(manifests[j].first, drogon::utils::base64Decode(data["content"].asString()));
        }));
        for (auto& read : reads) { const auto item = read.get(); if (item.second.empty()) truncated = true; else files.insert(item); }
    }
    auto result = detect(files, truncated); result["revision"] = tree["sha"].asString();
    return result;
}

std::string ProjectStackInspector::remoteCommand() {
    // Python uses only its standard library, rejects links and never imports
    // modules or executes files from the project. No user text is interpolated.
    const std::string script = R"PY(import os,json,pathlib
names={'package.json','requirements.txt','pyproject.toml','Pipfile','go.mod','Cargo.toml','pom.xml','build.gradle','build.gradle.kts','composer.json','Gemfile','CMakeLists.txt','Dockerfile','docker-compose.yml','docker-compose.yaml','compose.yml','compose.yaml','schema.prisma'}
skip={'.git','node_modules','.next','.venv','venv','vendor','dist','build','target','.cache','coverage'}
root=pathlib.Path.cwd().resolve(); files={}; total=0; count=0; truncated=False
for directory,dirs,entries in os.walk(root,followlinks=False):
    current=pathlib.Path(directory); depth=len(current.relative_to(root).parts)
    dirs[:]=sorted(d for d in dirs if d not in skip and depth<5 and not (current/d).is_symlink())
    for name in sorted(entries):
        count+=1; path=current/name
        if count>4000 or len(files)>=24: truncated=True; break
        if name not in names and not name.endswith('.csproj'): continue
        if path.is_symlink(): continue
        try:
            if path.stat().st_size>16384: truncated=True; continue
            data=path.read_bytes()[:65537]
            if len(data)>16384 or total+len(data)>24000: truncated=True; continue
            files[path.relative_to(root).as_posix()]=data.decode('utf-8-sig'); total+=len(data)
        except (OSError,UnicodeError): truncated=True
    if count>4000 or len(files)>=24: break
print('__STACKPILOT_MANIFESTS__'+json.dumps({'files':files,'truncated':truncated},separators=(',',':')))
)PY";
    return "python3 -I -c " + strings::shellQuote(script);
}

Json::Value ProjectStackInspector::remoteOutput(const std::string& output) {
    const std::string marker = "__STACKPILOT_MANIFESTS__"; const auto start = output.find(marker);
    if (start == std::string::npos) return unavailable("Remote inspection is unavailable. The server needs Python 3 and a readable source folder.");
    const auto data = parse(output.substr(start + marker.size(), output.find('\n', start) - start - marker.size()));
    if (!data["files"].isObject()) return unavailable("The server returned incomplete inspection data; project creation is still available.");
    Manifests files;
    for (const auto& key : data["files"].getMemberNames()) if (data["files"][key].isString()) files[key] = data["files"][key].asString();
    return detect(files, data["truncated"].asBool());
}
} // namespace stackpilot
