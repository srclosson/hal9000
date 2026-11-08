// The screens a ship can be shown on. Each is a whole UI built on shared.js (and so on protocol.js): a different way
// of working with the same 9000, not a skin. Chosen per device: a TV can show the 9000 monitor while a laptop in the
// same ship shows the dashboard, one conversation between them. persona: the one a UI suggests for a new ship.
export const UIS = [
  { id: '9000', name: '9000 monitor', page: '/monitor', persona: null, about: 'Discovery One screens, spoken answers, the eye' },
  { id: 'dashboard', name: 'Dashboard', page: '/dashboard', persona: 'assistant', about: 'Panels with a written conversation beside them' },
];
export const linkTo = (id, room) => { const ui = UIS.find(u => u.id === id) ?? UIS[0]; return `${ui.page}${room ? `?room=${encodeURIComponent(room)}` : ''}`; };
