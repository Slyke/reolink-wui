import adapter from '@sveltejs/adapter-node';

export default {
  kit: {
    adapter: adapter(),
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'img-src': ['self', 'blob:'],
        'media-src': ['self', 'blob:'],
        'connect-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'script-src': ['self'],
        'base-uri': ['none'],
        'object-src': ['none'],
        'frame-ancestors': ['none']
      }
    }
  }
};
