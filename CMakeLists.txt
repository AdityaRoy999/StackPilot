cmake_minimum_required(VERSION 3.20)
project(stackpilot-platform VERSION 0.1.0 LANGUAGES CXX)

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

# ─── Unit Tests ─────────────────────────────────────────────────
# Off by default so the production image build does not pay for it.
# Enable with: cmake -DSTACKPILOT_BUILD_TESTS=ON
option(STACKPILOT_BUILD_TESTS "Build the C++ unit test binary" OFF)

if(STACKPILOT_BUILD_TESTS)
    enable_testing()

    file(GLOB UNIT_TEST_SOURCES "tests/unit/cpp/*_test.cpp")

    # Link only the translation units under test. Pulling in the full source
    # glob would drag every controller (and Drogon's static route registration)
    # into a binary that never serves a request.
    add_executable(stackpilot_unit_tests
        ${UNIT_TEST_SOURCES}
        tests/unit/cpp/main.cpp
        src/utils/JwtHelper.cpp
        src/db/Database.cpp
        src/services/ComposeKubernetesPlanner.cpp
        src/utils/RuntimeRateLimiter.cpp
        src/utils/Authz.cpp
        src/services/DriftDetector.cpp
        src/services/CostModel.cpp
        src/services/PreviewEnvironments.cpp
        src/services/AiStreamProxy.cpp
        src/services/BuildService.cpp
        src/services/AiServiceClient.cpp
        src/services/ClusterTargets.cpp
        src/services/LocalDockerRuntime.cpp
        src/services/DeploymentJournal.cpp
        src/services/RemoteAccess.cpp
        src/utils/BlockingTaskRunner.cpp
        src/services/SshService.cpp
        src/controllers/LogWebSocketController.cpp
        src/utils/TokenCrypto.cpp
    )

    target_include_directories(stackpilot_unit_tests PRIVATE
        ${CMAKE_SOURCE_DIR}/src
        ${PQXX_INCLUDE_DIRS}
        ${JSONCPP_INCLUDE_DIRS}
    )

    target_link_libraries(stackpilot_unit_tests PRIVATE
        Drogon::Drogon
        spdlog::spdlog
        OpenSSL::Crypto
        CURL::libcurl
        ${PQXX_LIBRARIES}
        ${JSONCPP_LIBRARIES}
    )

    target_link_directories(stackpilot_unit_tests PRIVATE
        ${PQXX_LIBRARY_DIRS}
        ${JSONCPP_LIBRARY_DIRS}
    )

    add_test(NAME unit COMMAND stackpilot_unit_tests)
endif()
