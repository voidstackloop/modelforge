import { ShieldCheck } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineNotice } from "@/components/ds";
import { useAuth } from "@/lib/auth/auth-context";

export default function Login() {
    const { user, isLoading, authError, signIn } = useAuth();
    const location = useLocation();

    if (isLoading) return null;
    if (user && !user.expired) {
        const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
        return <Navigate to={returnTo ?? "/"} replace />;
    }

    return (
        <div className="flex h-screen items-center justify-center bg-muted/30 p-4">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <ShieldCheck className="size-5" />
                    </div>
                    <CardTitle>ModelForge Admin Console</CardTitle>
                    <CardDescription>Sign in with your organization identity provider to manage users, groups, and policies.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    {authError && (
                        <InlineNotice variant="destructive" title="Sign-in failed">
                            {authError}
                        </InlineNotice>
                    )}
                    <Button onClick={() => void signIn()}>Sign in</Button>
                </CardContent>
            </Card>
        </div>
    );
}
