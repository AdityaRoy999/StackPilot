-- Store the preferred exposure mode for SSH/VPS Kubernetes deployments.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS remote_k8s_exposure VARCHAR(20) NOT NULL DEFAULT 'nodeport';

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_remote_k8s_exposure_check,
    ADD CONSTRAINT projects_remote_k8s_exposure_check
        CHECK (remote_k8s_exposure IN ('nodeport', 'ingress', 'loadbalancer', 'clusterip'));
