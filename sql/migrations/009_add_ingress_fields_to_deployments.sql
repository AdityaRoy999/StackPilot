-- Add ingress/runtime exposure metadata for production-grade Kubernetes runtimes
ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS k8s_ingress_name VARCHAR(150) DEFAULT '',
    ADD COLUMN IF NOT EXISTS runtime_exposure VARCHAR(32) DEFAULT '';

UPDATE deployments
SET runtime_exposure = CASE
    WHEN COALESCE(k8s_ingress_name, '') <> '' THEN 'ingress'
    WHEN COALESCE(k8s_service_name, '') <> '' THEN 'service'
    ELSE ''
END
WHERE COALESCE(runtime_exposure, '') = '';
