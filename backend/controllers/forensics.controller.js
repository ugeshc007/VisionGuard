const { readDashboardData } = require("../utils/utils.js");
const { searchFaceEvidence, createIncidentReport } = require("../utils/faceEngine.js");

function enrichEvents(data, source = data.events) {
    return source.map((event) => ({
        ...event,
        camera: data.cameras.find((camera) => camera.id === event.cameraId) || null,
        person: data.people.find((person) => person.id === event.personId) || null,
        vehicle: data.vehicles.find((vehicle) => vehicle.id === event.vehicleId) || null,
        snapshot: event.snapshot || `/api/snapshot/${event.id}`
    }));
}

exports.getForensics = async (req, res, next) => {
    try {
        const q = String(req.query.q || "").toLowerCase();
        const data = await readDashboardData();
        const events = enrichEvents(data).filter((event) => JSON.stringify(event).toLowerCase().includes(q));
        res.status(200).json({ query: q, results: events });
    } catch (error) {
        next(error);
    }
};

exports.faceSearch = async (req, res, next) => {
    try {
        res.status(200).json(await searchFaceEvidence(req.body));
    } catch (error) {
        next(error);
    }
};

exports.createIncident = async (req, res, next) => {
    try {
        const data = await readDashboardData();
        res.status(201).json(await createIncidentReport(data, req.body.eventId, enrichEvents));
    } catch (error) {
        next(error);
    }
};
