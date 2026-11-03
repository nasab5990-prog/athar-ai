// PostgreSQL preview branch is intentionally disconnected from the existing Render API.
// Configure only a separate preview backend after explicit approval; never point this branch
// at the production/legacy API by accident.
window.ATHAR_CONFIG = { apiBase: '' };
