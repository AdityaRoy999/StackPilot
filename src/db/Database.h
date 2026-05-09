// ============================================================
// Database.h — PostgreSQL Connection Manager (Singleton)
// ============================================================
// CONCEPT: Singleton Pattern
// A singleton ensures only ONE instance of a class exists.
// We want exactly ONE database connection pool for the entire
// application. Multiple connections would waste resources.
//
// Usage: auto& db = Database::getInstance();
//
// CONCEPT: Connection String
// PostgreSQL uses a connection string to know WHERE to connect:
// "host=localhost port=5432 dbname=mydb user=admin password=secret"
// ============================================================

#pragma once

#include <string>
#include <memory>
#include <pqxx/pqxx>
#include <mutex>

namespace dokscp {

class Database {
public:
    // ─── Singleton access ───────────────────────────────────
    // static means this belongs to the CLASS, not an instance
    // Returns a reference (&) to the single instance
    static Database& getInstance() {
        static Database instance;  // Created once, lives forever
        return instance;
    }

    // ─── Initialize connection ──────────────────────────────
    void initialize(
        const std::string& host,
        int port,
        const std::string& dbname,
        const std::string& user,
        const std::string& password
    );

    // ─── Get a connection for queries ───────────────────────
    // Returns a unique_ptr — the caller owns the connection
    // and it's automatically cleaned up when done
    std::unique_ptr<pqxx::connection> getConnection();

    // ─── Check if connected ─────────────────────────────────
    bool isConnected() const { return m_initialized; }

    // ─── Run migrations ─────────────────────────────────────
    void runMigrations(const std::string& migrationsPath);

    // Delete copy/move to enforce singleton
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

private:
    Database() = default;  // Private constructor = can't create from outside

    std::string m_connString;
    bool m_initialized = false;
    std::mutex m_mutex;  // Thread safety for initialization
};

} // namespace dokscp
