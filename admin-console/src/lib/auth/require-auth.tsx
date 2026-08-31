import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./auth-context";

export function RequireAuth({ children }: { children: ReactNode }) {
    const { user, isLoading } = useAuth();
    const location = useLocation();
    if (isLoading) return null;
    if (!user || user.expired) {
        return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
    }
    return <>{children}</>;
}
