---
status: accepted
---

# Keep PhotoAgent and Lightroom MCP separate

PhotoAgent remains the upper-level Workflow Orchestrator in an independent repository, while `lightroom-mcp` remains an independently usable lower-level Lightroom Backend. The dependency is one-way, `photo-agent -> lightroom-mcp`, so workflow releases do not absorb Lightroom transport and plug-in ownership; compatibility must instead be made explicit through a versioned capability handshake.
