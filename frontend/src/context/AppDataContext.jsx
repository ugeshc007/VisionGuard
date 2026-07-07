import { createContext, useCallback, useContext, useState } from "react";
import { api } from "../lib/api.js";

const AppDataContext = createContext(null);

const initialState = {
  summary: null,
  events: [],
  people: [],
  cameras: [],
  sites: [],
  rules: [],
  vehicles: [],
  attendance: [],
  visits: [],
  faces: [],
  faceDays: [],
  tracks: [],
  privacy: null,
  reportsData: {
    attendance: [],
    attendancePeople: [],
    vehicles: [],
    traffic: { flowSummary: [], people: [] },
    analytics: { byType: {}, bySeverity: {}, byCamera: {}, trends: [] }
  }
};

export function AppDataProvider({ children }) {
  const [data, setData] = useState(initialState);

  const reloadFaces = useCallback(async () => {
    const facesData = await api("/api/faces");
    const history = await api("/api/face-days");
    setData((prev) => ({
      ...prev,
      faces: facesData.faces || [],
      faceDays: history.days || []
    }));
  }, []);

  const reloadReports = useCallback(async (date, filter = "all") => {
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const [attendanceRes, vehiclesRes, trafficRes, analyticsRes] = await Promise.all([
      api("/api/attendance"),
      api("/api/vehicles"),
      api(`/api/area-traffic?date=${encodeURIComponent(targetDate)}`),
      api("/api/analytics")
    ]);
    setData((prev) => ({
      ...prev,
      reportsData: {
        attendance: attendanceRes.attendance || [],
        attendancePeople: attendanceRes.people || [],
        vehicles: vehiclesRes.vehicles || [],
        traffic: trafficRes,
        analytics: analyticsRes
      }
    }));
    return { targetDate, filter };
  }, []);

  const reload = useCallback(async (reportsArgs = {}) => {
    const [dashboardData, tracksData, privacyData] = await Promise.all([
      api("/api/dashboard"),
      api("/api/person-tracks").catch(() => ({ tracks: [] })),
      api("/api/privacy").catch(() => ({ policy: null }))
    ]);
    setData((prev) => ({
      ...prev,
      ...dashboardData,
      events: dashboardData.events || [],
      cameras: dashboardData.cameras || [],
      sites: dashboardData.sites || [],
      people: dashboardData.people || [],
      rules: dashboardData.rules || [],
      vehicles: dashboardData.vehicles || [],
      attendance: dashboardData.attendance || [],
      visits: dashboardData.visits || [],
      tracks: tracksData.tracks || [],
      privacy: privacyData.policy || null
    }));
    await reloadFaces();
    await reloadReports(reportsArgs.date, reportsArgs.filter);
  }, [reloadFaces, reloadReports]);

  const processPendingFaces = useCallback(async () => {
    const result = await api("/api/faces/process", { method: "POST", body: "{}" });
    await reload();
    return result;
  }, [reload]);

  const cameraName = useCallback((id) => data.cameras.find((c) => c.id === id)?.name || id || "", [data.cameras]);
  const siteName = useCallback((id) => data.sites.find((s) => s.id === id)?.name || id || "", [data.sites]);

  const value = { data, reload, reloadFaces, reloadReports, processPendingFaces, cameraName, siteName };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used within AppDataProvider");
  return context;
}
