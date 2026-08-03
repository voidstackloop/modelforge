import { createHashRouter, RouterProvider } from "react-router-dom";
import Layout from "./components/layout";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Compare from "./pages/Compare";
import UsageDashboard from "./pages/UsageDashboard";
import DownloadCenter from "./pages/DownloadCenter";
import RuntimeManager from "./pages/RuntimeManager";
import PatientCases from "./pages/PatientCases";
import PatientCaseDetail from "./pages/PatientCaseDetail";
import EvidenceLibrary from "./pages/EvidenceLibrary";
import KnowledgeGraph from "./pages/KnowledgeGraph";
import AuditPrivacy from "./pages/AuditPrivacy";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
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
      { path: "compare", element: <Compare /> },
      { path: "usage", element: <UsageDashboard /> },
      { path: "downloads", element: <DownloadCenter /> },
      { path: "runtimes", element: <RuntimeManager /> },
      { path: "cases", element: <PatientCases /> },
      { path: "cases/:caseId", element: <PatientCaseDetail /> },
      { path: "evidence", element: <EvidenceLibrary /> },
      { path: "knowledge-graph", element: <KnowledgeGraph /> },
      { path: "audit", element: <AuditPrivacy /> },
    ],
  },
]);

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="app-ui-theme">
      <I18nProvider>
        <ToastProvider>
          <SessionsProvider>
            <RouterProvider router={router} />
          </SessionsProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App
