import { createHashRouter, RouterProvider } from "react-router-dom";
import Layout from "./components/layout";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionsProvider } from "@/lib/sessions-context";
import { I18nProvider } from "@/lib/i18n";

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Chat /> },
      { path: "chat/:sessionId", element: <Chat /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="app-ui-theme">
      <I18nProvider>
        <SessionsProvider>
          <RouterProvider router={router} />
        </SessionsProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App
