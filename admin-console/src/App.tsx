import { createHashRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { AuthProvider } from "@/lib/auth/auth-context";
import { RequireAuth } from "@/lib/auth/require-auth";
import { MeProvider, RequireOrg } from "@/lib/org-context";
import Layout from "@/components/layout";
import Login from "@/pages/Login";
import OrgPicker from "@/pages/OrgPicker";
import Users from "@/pages/Users";
import Invitations from "@/pages/Invitations";
import Groups from "@/pages/Groups";
import Policies from "@/pages/Policies";
import ServicePrincipals from "@/pages/ServicePrincipals";
import Audit from "@/pages/Audit";
import BreakGlass from "@/pages/BreakGlass";
import AccessReviews from "@/pages/AccessReviews";
import Backup from "@/pages/Backup";
import Inference from "@/pages/Inference";
import McpRegistry from "@/pages/McpRegistry";
import Compute from "@/pages/Compute";

// createHashRouter, not createBrowserRouter: zero-config-safe — works from
// any static host with no SPA-fallback rewrite rule needed. Isolated to
// this one line so it can move to createBrowserRouter later once a
// deployment target with SPA-fallback routing is confirmed; oidc-config.ts's
// callback handling already works identically under either router.
const router = createHashRouter([
    { path: "/login", element: <Login /> },
    {
        path: "/",
        // One shared MeProvider for both the org picker and every org
        // route below it — GET /me is fetched once per session instead of
        // once per screen, and switching organizations never re-fetches it.
        element: (
            <RequireAuth>
                <MeProvider>
                    <Outlet />
                </MeProvider>
            </RequireAuth>
        ),
        children: [
            { index: true, element: <OrgPicker /> },
            {
                path: "organizations/:organizationId",
                element: (
                    <RequireOrg>
                        <Layout />
                    </RequireOrg>
                ),
                children: [
                    { index: true, element: <Navigate to="users" replace /> },
                    { path: "users", element: <Users /> },
                    { path: "invitations", element: <Invitations /> },
                    { path: "groups", element: <Groups /> },
                    { path: "policies", element: <Policies /> },
                    { path: "service-principals", element: <ServicePrincipals /> },
                    { path: "audit", element: <Audit /> },
                    { path: "break-glass", element: <BreakGlass /> },
                    { path: "access-reviews", element: <AccessReviews /> },
                    { path: "backup", element: <Backup /> },
                    { path: "inference", element: <Inference /> },
                    { path: "mcp-registry", element: <McpRegistry /> },
                    { path: "compute", element: <Compute /> },
                ],
            },
        ],
    },
]);

export default function App() {
    return (
        <ThemeProvider defaultTheme="system" storageKey="admin-console-theme">
            <ToastProvider>
                <AuthProvider>
                    <RouterProvider router={router} />
                </AuthProvider>
            </ToastProvider>
        </ThemeProvider>
    );
}
