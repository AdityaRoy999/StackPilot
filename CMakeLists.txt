cmake_minimum_required(VERSION 3.20)
project(dokscp-platform VERSION 0.1.0 LANGUAGES CXX)

# ─── C++ Standard ───────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ─── Find Packages ────────────────────────
find_package(Drogon REQUIRED)
find_package(spdlog REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(CURL REQUIRED)

# Use PkgConfig as a fallback for libpqxx and jsoncpp
find_package(PkgConfig REQUIRED)

# Find pqxx
pkg_check_modules(PQXX REQUIRED libpqxx)

# Find jsoncpp
pkg_check_modules(JSONCPP REQUIRED jsoncpp)

# ─── Collect Source Files ────────────────────────────────────────
file(GLOB_RECURSE SOURCES
    "src/*.cpp"
)

# ─── Main Executable ────────────────────────────────────────────
add_executable(${PROJECT_NAME} ${SOURCES})

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${PQXX_INCLUDE_DIRS}
    ${JSONCPP_INCLUDE_DIRS}
)

# Link everything
target_link_libraries(${PROJECT_NAME} PRIVATE
    Drogon::Drogon
    spdlog::spdlog
    OpenSSL::Crypto
    CURL::libcurl
    ${PQXX_LIBRARIES}
    ${JSONCPP_LIBRARIES}
)

# Add library directories if needed
target_link_directories(${PROJECT_NAME} PRIVATE
    ${PQXX_LIBRARY_DIRS}
    ${JSONCPP_LIBRARY_DIRS}
)

# ─── Copy config to build directory ─────────────────────────────
configure_file(
    ${CMAKE_SOURCE_DIR}/config/config.json
    ${CMAKE_BINARY_DIR}/config.json
    COPYONLY
)
