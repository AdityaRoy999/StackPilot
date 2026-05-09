-- Track multi-node Kubernetes clusters bootstrapped through saved remote connections.
CREATE TABLE IF NOT EXISTS kubernetes_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    provider VARCHAR(30) NOT NULL DEFAULT 'k3s',
    control_plane_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL,
    server_url TEXT NOT NULL DEFAULT '',
    join_token_encrypted TEXT NOT NULL DEFAULT '',
    status VARCHAR(40) NOT NULL DEFAULT 'initializing',
    last_status TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS kubernetes_cluster_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID NOT NULL REFERENCES kubernetes_clusters(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('server', 'agent')),
    status VARCHAR(40) NOT NULL DEFAULT 'joining',
    last_status TEXT NOT NULL DEFAULT '',
    joined_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(cluster_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_kubernetes_clusters_user_id
    ON kubernetes_clusters(user_id);

CREATE INDEX IF NOT EXISTS idx_kubernetes_cluster_nodes_connection_id
    ON kubernetes_cluster_nodes(connection_id);
