import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1",
  withCredentials: true,
  timeout: 25000,
  headers: {
    "Content-Type": "application/json",
    "X-AIDS-CSRF": "1",
  },
});

// Add a response interceptor to handle global errors (e.g., 401 Unauthorized)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== "undefined") {
        const currentPath = window.location.pathname;
        if (!currentPath.startsWith("/auth/")) {
          window.location.href = "/auth/login";
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
