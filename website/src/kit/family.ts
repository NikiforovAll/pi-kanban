export type SiteId = 'pi' | 'kanban' | 'packages';

export const family: { id: SiteId; name: string; href: string; blurb: string }[] = [
  { id: 'pi', name: 'pi', href: 'https://pi.dev', blurb: 'The pi coding agent' },
  { id: 'kanban', name: 'pi-kanban', href: 'https://nikiforovall.blog/pi-kanban/', blurb: 'An agent development environment for pi' },
  { id: 'packages', name: 'pi packages', href: 'https://www.npmjs.com/search?q=keywords%3Api-package', blurb: 'Extensions for pi on npm' },
];

export const url = (path = '') => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
