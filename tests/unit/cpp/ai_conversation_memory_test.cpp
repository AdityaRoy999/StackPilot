#include "testing.h"
#include "../../../src/services/AiConversationMemory.h"

using namespace stackpilot::aiMemory;

TEST(ConversationMemory, ReloadsSavedContextAndHandlesInvalidLegacyGraph) {
    auto memory = sessionMemory("Use concise replies", "not json");
    EXPECT_EQ(memory["summary"].asString(), "Use concise replies");
    EXPECT_TRUE(memory["graph"].isObject());
}

TEST(ConversationMemory, PreservesPreferencesBeyondTheRecentMessageWindow) {
    Json::Value graph(Json::objectValue);
    graph = updateMemoryGraph(graph, "Remember my project is Atlas", "Understood");
    for (int i=0; i<35; ++i) graph = updateMemoryGraph(graph, "Inspect the deployment", "Inspected");
    EXPECT_EQ(graph["preferences"].size(), 1u);
    EXPECT_EQ(graph["preferences"][0].asString(), "Remember my project is Atlas");
}

TEST(ConversationMemory, BoundsSummariesAndPreferenceGrowth) {
    std::string summary;
    Json::Value graph(Json::objectValue);
    for (int i=0; i<50; ++i) {
        summary=updateMemorySummary(summary,std::string(800,'u'),std::string(800,'a'));
        graph=updateMemoryGraph(graph,"Remember "+std::to_string(i),"Saved");
    }
    EXPECT_TRUE(summary.size()<=6000);
    EXPECT_EQ(graph["preferences"].size(),24u);
    EXPECT_EQ(graph["preferences"][23].asString(),"Remember 49");
}

TEST(ConversationMemory, TruncatesAtUtf8Boundaries) {
    const std::string devanagari = "\xe0\xa4\xa8";
    EXPECT_EQ(clipText(devanagari + devanagari, 4), devanagari);
    EXPECT_EQ(clipText(devanagari, 2), "");
    EXPECT_EQ(clipText("abc" + devanagari, 3), devanagari);
    EXPECT_EQ(clipText("abc", 0), "");
}
