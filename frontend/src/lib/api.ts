import axios from "axios";
import { isRemotePlatform, remoteHeaders, forgetRemoteDevice } from "./remote-platform";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1",
  withCredentials: true,
  timeout: 25000,
  headers: {
    "Content-Type": "application/json",
    "X-stackpilot-CSRF": "1",
  },
});

api.interceptors.request.use((config) => {
  if (isRemotePlatform()) {
    config.baseURL = "/api/v1";
    Object.assign(config.headers, remoteHeaders());
    config.withCredentials = true;
  }
  return config;
});

// Add a response interceptor to handle global errors (e.g., 401 Unauthorized)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== "undefined") {
        // An in-flight response from a revoked device must not sign out a
        // newly paired phone that has already replaced that credential.
        const sentAuthorization = String(error.config?.headers?.Authorization || "");
        if (sentAuthorization.startsWith("Bearer sp_remote_") &&
            sentAuthorization !== remoteHeaders().Authorization) return Promise.reject(error);
        const currentPath = window.location.pathname;
        if (isRemotePlatform()) {
          forgetRemoteDevice();
          window.location.href = `/remote?next=${encodeURIComponent(currentPath + window.location.search)}`;
          return Promise.reject(error);
        }
        if (
          !currentPath.startsWith("/auth/") &&
          currentPath !== "/login" &&
          currentPath !== "/register" &&
          currentPath !== "/forgot-password"
        ) {
          window.location.href = "/auth/login";
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
