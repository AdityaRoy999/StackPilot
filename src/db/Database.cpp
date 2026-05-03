// ============================================================
// Database.cpp — PostgreSQL Connection Implementation
// ============================================================

#include "Database.h"
#include <spdlog/spdlog.h>
#include <filesystem>
#include <fstream>
#include <algorithm>

namespace aids {

void Database::initialize(
    const std::string& host,
    int port,
    const std::string& dbname,
    const std::string& user,
    const std::string& password
) {
    std::lock_guard<std::mutex> lock(m_mutex);

    // CONCEPT: Connection string format for PostgreSQL
    // This tells libpqxx how to find and authenticate with the database
    m_connString = "host=" + host +
                   " port=" + std::to_string(port) +
                   " dbname=" + dbname +
                   " user=" + user +
                   " password=" + password;

    // Test the connection
    try {
        auto conn = std::make_unique<pqxx::connection>(m_connString);
        if (conn->is_open()) {
            spdlog::info("Connected to PostgreSQL: {}", dbname);
            m_initialized = true;
        } else {
            throw std::runtime_error("Connection opened but is_open() returned false");
        }
    } catch (const std::exception& e) {
        spdlog::error("PostgreSQL connection failed: {}", e.what());
        throw;
    }
}

std::unique_ptr<pqxx::connection> Database::getConnection() {
    if (!m_initialized) {
        throw std::runtime_error("Database not initialized. Call initialize() first.");
    }

    // CONCEPT: Each request gets its own connection
    // In production, you'd use a connection POOL for efficiency
    // For now, creating a new connection per request is fine for learning
    return std::make_unique<pqxx::connection>(m_connString);
}

void Database::runMigrations(const std::string& migrationsPath) {
    // CONCEPT: Migrations run SQL files in alphabetical order
    // 001_create_users.sql runs before 002_create_projects.sql
    // This ensures tables are created in the right dependency order

    spdlog::info("Running migrations from: {}", migrationsPath);

    auto conn = getConnection();
    namespace fs = std::filesystem;

    // Collect all .sql files
    std::vector<fs::path> sqlFiles;
    for (const auto& entry : fs::directory_iterator(migrationsPath)) {
        if (entry.path().extension() == ".sql") {
            sqlFiles.push_back(entry.path());
        }
    }

    // Sort alphabetically (001 before 002 before 003)
    std::sort(sqlFiles.begin(), sqlFiles.end());

    for (const auto& file : sqlFiles) {
        spdlog::info("Running migration: {}", file.filename().string());

        // Read the SQL file
        std::ifstream ifs(file);
        std::string sql((std::istreambuf_iterator<char>(ifs)),
                         std::istreambuf_iterator<char>());

        // Execute the SQL
        try {
            pqxx::work txn(*conn);  // Start a transaction
            txn.exec(sql);          // Execute SQL
            txn.commit();           // Commit if successful
            spdlog::info("  ✓ Migration applied: {}", file.filename().string());
        } catch (const std::exception& e) {
            spdlog::warn("  ⚠ Migration may already be applied: {} — {}",
                         file.filename().string(), e.what());
        }
    }

    spdlog::info("All migrations processed");
}

} // namespace aids
