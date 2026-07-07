import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppDataProvider, useAppData } from "./context/AppDataContext.jsx";
import { UiProvider, useUi } from "./context/UiContext.jsx";
import AppLayout from "./layouts/AppLayout.jsx";
import DashboardView from "./views/DashboardView.jsx";
import CamerasView from "./views/CamerasView.jsx";
import PeopleView from "./views/PeopleView.jsx";
import RulesView from "./views/RulesView.jsx";
import EventsView from "./views/EventsView.jsx";
import ForensicsView from "./views/ForensicsView.jsx";
import ReportsView from "./views/ReportsView.jsx";

function InitialLoader({ children }) {
  const { reload } = useAppData();
  const { toast } = useUi();

  useEffect(() => {
    reload().catch((error) => toast(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return children;
}

export default function App() {
  return (
    <UiProvider>
      <AppDataProvider>
        <InitialLoader>
          <BrowserRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<DashboardView />} />
                <Route path="cameras" element={<CamerasView />} />
                <Route path="people" element={<PeopleView />} />
                <Route path="rules" element={<RulesView />} />
                <Route path="events" element={<EventsView />} />
                <Route path="forensics" element={<ForensicsView />} />
                <Route path="reports" element={<ReportsView />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </InitialLoader>
      </AppDataProvider>
    </UiProvider>
  );
}
