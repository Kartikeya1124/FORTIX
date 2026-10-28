export interface ApiItem {
  id: string;
  name: string;
  category: string;
  url: string;
  apiKey: string;
  authType: 'none' | 'header' | 'oauth2' | 'query' | 'bearer' | string;
  headerKey?: string;
  docsUrl?: string;
  description: string;
  tags: string[];
  status: 'active' | 'inactive' | 'deprecated' | string;
  rateLimit?: string;
  notes?: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}
