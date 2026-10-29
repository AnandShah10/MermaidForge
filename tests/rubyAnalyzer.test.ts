import { describe, it, expect } from 'vitest';
import { parseRuby, analyzeRubyClasses, analyzeRubyImports, analyzeRubyCalls, rubyImportGraphAnalyzer, rubyCallGraphAnalyzer } from '../src/analyzers/ruby/rubyAnalyzer';
import { analyzeRubyRoutes, rubyRouteAnalyzer } from '../src/analyzers/ruby/rubyRouteAnalyzer';
import { classesToClassDiagram, codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
const routeLabels = (g: { nodes: Array<{ kind?: string; label: string }> }) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const short = (g: { edges: Array<{ from: string; to: string; kind?: string }> }) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
const draw = (body: string) => analyzeRubyRoutes([f('config/routes.rb', `Rails.application.routes.draw do\n${body}\nend\n`)]);

describe('parseRuby', () => {
  it('reads classes, superclasses, modules and nesting', () => {
    const p = parseRuby(`module Shop
  class Order < Base
  end
  module Util
  end
end`);
    const by = (n: string) => p.types.find((t) => t.name === n)!;
    expect(by('Shop').kind).toBe('module');
    expect(by('Order').superName).toBe('Base');
    expect(by('Order').fullName).toBe('Shop::Order');
    expect(by('Util').outer).toBe('Shop');
  });
  it('pairs end correctly with modifier if/unless and loops inside methods', () => {
    const p = parseRuby(`class A
  def a
    return 1 if x
    puts 2 unless y
    items.each do |i|
      while i > 0
        i -= 1
      end
    end
  end
  def b; end
end
class B; end`);
    expect(p.types.map((t) => t.name)).toEqual(['A', 'B']);
    expect(p.types[0].methods.map((m) => m.name)).toEqual(['a', 'b']);
  });
  it('tracks visibility sections and private with an argument', () => {
    const p = parseRuby(`class A
  def pub; end
  protected
  def prot; end
  private
  def priv; end
  public
  def pub2; end
  def late; end
  private :late
end`);
    const m = (n: string) => p.types[0].methods.find((x) => x.name === n)!.visibility;
    expect(m('pub')).toBe('public');
    expect(m('prot')).toBe('protected');
    expect(m('priv')).toBe('private');
    expect(m('pub2')).toBe('public');
  });
  it('reads attr_* declarations and mixins', () => {
    const p = parseRuby(`class A
  include Comparable
  extend Forwardable
  attr_accessor :name, :age
  attr_reader :id
end`);
    const t = p.types[0];
    expect(t.attrs.map((a) => a.name).sort()).toEqual(['age', 'id', 'name']);
    expect(t.mixins.map((m) => m.name)).toContain('Comparable');
  });
  it('reads class methods (self.) and endless defs', () => {
    const p = parseRuby(`class A
  def self.build; new; end
  def double(x) = x * 2
  def after; end
end`);
    const ms = p.types[0].methods;
    expect(ms.find((m) => m.name === 'build')!.isStatic).toBe(true);
    expect(ms.map((m) => m.name)).toEqual(['build', 'double', 'after']);
  });
  it('is not confused by strings and comments that contain keywords', () => {
    const p = parseRuby(`class A
  # class Fake
  def a
    s = "end class def"
    t = 'end'
  end
end`);
    expect(p.types.map((t) => t.name)).toEqual(['A']);
    expect(p.types[0].methods.map((m) => m.name)).toEqual(['a']);
  });
  it('reads requires', () => {
    const p = parseRuby(`require 'json'
require_relative 'lib/helper'
load 'x.rb'`);
    expect(p.requires.map((r) => [r.kind, r.path])).toEqual([['require', 'json'], ['require_relative', 'lib/helper'], ['load', 'x.rb']]);
  });
  it('never throws on unbalanced input', () => {
    expect(() => parseRuby('class A\n def x\n if y\n')).not.toThrow();
    expect(() => parseRuby('end end end')).not.toThrow();
  });
});

describe('analyzeRubyClasses', () => {
  const src = `module Auditable
  def audit; end
end
class Base; end
class User < Base
  include Auditable
  attr_reader :name
  def initialize(name); @name = name; end
  def self.find(id); end
  def greet; end
  private
  def secret; end
end`;
  it('maps inheritance, mixin realization, visibility and static members', () => {
    const { classes, relationships } = analyzeRubyClasses([f('a.rb', src)]);
    const user = classes.find((c) => c.id === 'User')!;
    expect(user.members.some((m) => m.includes('greet'))).toBe(true);
    expect(user.members.some((m) => /^[-]\s*secret|-secret/.test(m.replace(/\s/g, '')))).toBe(true);
    expect(relationships).toContainEqual({ from: 'User', to: 'Base', type: 'inheritance' });
    expect(relationships).toContainEqual({ from: 'User', to: 'Auditable', type: 'realization' });
    expect(classes.find((c) => c.id === 'Auditable')!.stereotype).toBe('interface');
  });
  it('merges reopened classes', () => {
    const { classes } = analyzeRubyClasses([f('a.rb', 'class A\n def x; end\nend\nclass A\n def y; end\nend')]);
    expect(classes.filter((c) => c.id === 'A')).toHaveLength(1);
    expect(classes[0].members.length).toBe(2);
  });
  it('renders to a parseable class diagram', () => {
    const { classes, relationships } = analyzeRubyClasses([f('a.rb', src)]);
    const text = classesToClassDiagram(classes, relationships);
    expect(() => parseMermaid(text)).not.toThrow();
    expect(text).toContain('User');
  });
});

describe('analyzeRubyImports', () => {
  it('resolves require_relative', () => {
    const g = analyzeRubyImports([f('lib/a.rb', "require_relative 'b'\nclass A; end"), f('lib/b.rb', 'class B; end')]);
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['lib/a.rb->lib/b.rb']);
  });
  it('resolves File.expand_path(..., __FILE__) style requires', () => {
    const g = analyzeRubyImports([f('lib/a.rb', "require File.expand_path('../b', __FILE__)"), f('lib/b.rb', 'x = 1')]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].to).toBe('lib/b.rb');
  });
  it('resolves require against a scanned load path suffix and ignores gems', () => {
    const g = analyzeRubyImports([f('app.rb', "require 'json'\nrequire 'myapp/util'"), f('lib/myapp/util.rb', 'module Util; end')]);
    expect(g.edges.map((e) => e.to)).toEqual(['lib/myapp/util.rb']);
  });
  it('links autoloaded constants by Zeitwerk path convention and by declared name', () => {
    const g = analyzeRubyImports([
      f('app/models/user.rb', 'class User\n  def go; Mailer.deliver(self); end\nend'),
      f('app/services/mailer.rb', 'class Mailer; end'),
    ]);
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toContain('app/models/user.rb->app/services/mailer.rb');
  });
  it('produces a parseable flowchart', () => {
    const g = rubyImportGraphAnalyzer.analyze([f('lib/a.rb', "require_relative 'b'"), f('lib/b.rb', '')]);
    expect(() => parseMermaid(codeGraphToFlowchart(g))).not.toThrow();
    expect(rubyImportGraphAnalyzer.supportedExtensions).toEqual(['.rb']);
  });
});

describe('analyzeRubyCalls', () => {
  it('connects paren-less calls between methods of one class', () => {
    const g = analyzeRubyCalls([f('a.rb', `class A
  def run
    prepare
    finish 1, 2
  end
  def prepare; end
  def finish(a, b); end
end`)]);
    expect(short(g)).toEqual(['A.run->A.finish', 'A.run->A.prepare']);
  });
  it('handles ?/! method names', () => {
    const g = analyzeRubyCalls([f('a.rb', `class A
  def go
    save! if valid?
  end
  def save!; end
  def valid?; end
end`)]);
    expect(short(g)).toEqual(['A.go->A.save!', 'A.go->A.valid?']);
  });
  it('types @ivar = Foo.new and Foo.new.bar receivers', () => {
    const g = analyzeRubyCalls([f('a.rb', `class Repo
  def save(x); end
  def find(id); end
end
class Svc
  def initialize
    @repo = Repo.new
  end
  def a(x)
    @repo.save x
  end
  def b
    Repo.new.find 1
  end
end`)]);
    const s = short(g);
    expect(s).toContain('Svc.a->Repo.save');
    expect(s).toContain('Svc.b->Repo.find');
  });
  it('links Foo.new to initialize and class-method calls', () => {
    const g = analyzeRubyCalls([f('a.rb', `class Foo
  def initialize(x); end
  def self.build; end
end
class Bar
  def make
    Foo.new(1)
    Foo.build
  end
end`)]);
    const s = short(g);
    expect(s).toContain('Bar.make->Foo.initialize');
    expect(s.some((e) => e.startsWith('Bar.make->Foo.') && e.includes('build'))).toBe(true);
  });
  it('does not link a local variable named like a method', () => {
    const g = analyzeRubyCalls([f('a.rb', `class A
  def run
    prepare = 1
    prepare
  end
  def prepare; end
end`)]);
    expect(g.edges).toHaveLength(0);
  });
  it('dispatches through super classes and mixins', () => {
    const g = analyzeRubyCalls([f('a.rb', `module Loud
  def shout; end
end
class Base
  def hello; end
end
class Kid < Base
  include Loud
  def go
    hello
    shout
  end
end`)]);
    const s = short(g);
    expect(s.some((e) => e.startsWith('Kid.go->Base.hello'))).toBe(true);
    expect(s.some((e) => e.startsWith('Kid.go->Loud.shout'))).toBe(true);
  });
  it('produces a parseable flowchart', () => {
    const g = rubyCallGraphAnalyzer.analyze([f('a.rb', 'class A\n def x; y; end\n def y; end\nend')]);
    expect(g.nodes.length).toBe(2);
    expect(() => parseMermaid(codeGraphToFlowchart(g))).not.toThrow();
  });
});

describe('Rails routes', () => {
  it('expands resources to the 7 standard routes', () => {
    const l = routeLabels(draw('resources :users'));
    expect(l).toEqual([
      'DELETE /users/:id | users#destroy',
      'GET /users | users#index',
      'GET /users/:id | users#show',
      'GET /users/:id/edit | users#edit',
      'GET /users/new | users#new',
      'PATCH|PUT /users/:id | users#update',
      'POST /users | users#create',
    ]);
  });
  it('honours only: and except:', () => {
    expect(routeLabels(draw('resources :a, only: [:index, :show]'))).toHaveLength(2);
    expect(routeLabels(draw('resources :a, except: %i[destroy new edit]'))).toHaveLength(4);
  });
  it('expands singular resource without index or id', () => {
    const l = routeLabels(draw('resource :profile'));
    expect(l).toHaveLength(6);
    expect(l).toContain('GET /profile | profiles#show');
  });
  it('nests resources with a parent id parameter', () => {
    const l = routeLabels(draw('resources :users do\n  resources :posts, only: :index\nend'));
    expect(l).toContain('GET /users/:user_id/posts | posts#index');
  });
  it('handles member and collection blocks', () => {
    const l = routeLabels(draw(`resources :users do
  member do
    post :ban
  end
  collection do
    get :search
  end
end`));
    expect(l).toContain('POST /users/:id/ban | users#ban');
    expect(l).toContain('GET /users/search | users#search');
  });
  it('mounts namespace as a router with module-qualified handlers', () => {
    const g = draw("namespace :admin do\n  resources :orders, only: :index\n  get 'dash', to: 'dashboard#show'\nend");
    expect(routeLabels(g)).toEqual(['GET /admin/dash | admin/dashboard#show', 'GET /admin/orders | admin/orders#index']);
    expect(g.nodes.some((n) => n.kind === 'router' && n.label.includes('/admin'))).toBe(true);
  });
  it('handles scope path / module / controller', () => {
    const l = routeLabels(draw(`scope '/api' do
  scope module: 'v1' do
    get 'ping', to: 'health#ping'
  end
end
controller :pages do
  get :about
end`));
    expect(l).toContain('GET /api/ping | v1/health#ping');
    expect(l).toContain('GET /about | pages#about');
  });
  it('reads to:, hash-rocket form, root and match via:', () => {
    const l = routeLabels(draw(`root 'home#index'
get '/a' => 'x#y'
match 'm', to: 'x#z', via: [:get, :post]
get 'old', to: redirect('/new')`));
    expect(l).toContain('GET / | home#index');
    expect(l).toContain('GET /a | x#y');
    expect(l).toContain('GET|POST /m | x#z');
    expect(l).toContain('GET /old | redirect /new');
  });
  it('expands concerns and mounts engines', () => {
    const l = routeLabels(draw(`concern :commentable do
  get 'comments'
end
resources :posts, only: :show, concerns: [:commentable]
mount Sidekiq::Web => '/sidekiq'
mount Blog::Engine, at: '/blog'`));
    expect(l).toContain('GET /posts/:id | posts#show');
    expect(l.some((x) => x.startsWith('GET /posts/:post_id/comments'))).toBe(true);
    expect(l).toContain('MOUNT /sidekiq | Sidekiq::Web');
    expect(l).toContain('MOUNT /blog | Blog::Engine');
  });
  it('ignores comments and dynamic paths do not crash', () => {
    const l = routeLabels(draw(`# get 'nope', to: 'x#y'
get "#{prefix}/x", to: 'a#b'`));
    expect(l).toHaveLength(1);
    expect(l[0]).toContain('(dynamic)');
  });
  it('produces a parseable flowchart', () => {
    const g = draw("root 'home#index'\nresources :users\nnamespace :admin do\n  resources :a\nend");
    expect(() => parseMermaid(codeGraphToFlowchart(g))).not.toThrow();
    expect(rubyRouteAnalyzer.supportedExtensions).toEqual(['.rb']);
  });
});

describe('Sinatra routes', () => {
  it('reads classic top-level routes', () => {
    const g = analyzeRubyRoutes([f('app.rb', `require 'sinatra'
get '/' do
  'hi'
end
post '/items/:id' do
  halt 200
end`)]);
    expect(routeLabels(g)).toEqual(['GET / | (block)', 'POST /items/:id | (block)']);
  });
  it('reads Sinatra::Base subclasses as routers and namespace blocks as prefixes', () => {
    const g = analyzeRubyRoutes([f('api.rb', `class Api < Sinatra::Base
  get '/health' do
    'ok'
  end
  namespace '/v1' do
    delete '/x/:id' do
    end
  end
end`)]);
    expect(routeLabels(g)).toEqual(['DELETE /v1/x/:id | (block)', 'GET /health | (block)']);
    expect(g.nodes.some((n) => n.kind === 'router' && n.label === 'Api')).toBe(true);
    expect(() => parseMermaid(codeGraphToFlowchart(g))).not.toThrow();
  });
  it('ignores ruby files that are neither Rails routes nor Sinatra', () => {
    expect(analyzeRubyRoutes([f('lib/x.rb', "class X\n def get(a); end\nend")]).nodes).toEqual([]);
  });
});

describe('rails: on: option', () => {
  it('get :feed, on: :collection inside resources is a collection route', () => {
    const g = rubyRouteAnalyzer.analyze([{ path: 'config/routes.rb', text: `Rails.application.routes.draw do\n  resources :articles, only: [:show] do\n    get :feed, on: :collection\n    get :preview, on: :member\n    get :other\n  end\nend\n` }]);
    const labels = g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
    expect(labels).toEqual(['GET /articles/:article_id/other | articles#other', 'GET /articles/:id | articles#show', 'GET /articles/:id/preview | articles#preview', 'GET /articles/feed | articles#feed']);
  });
});

describe('rails: brace blocks and inflections', () => {
  const lab = (text: string) => rubyRouteAnalyzer.analyze([{ path: 'config/routes.rb', text }]).nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('member { } and collection { } on one line and over several lines', () => {
    expect(lab(`Rails.application.routes.draw do
  resources :photos, only: [] do
    member { get :preview; post :crop }
    collection {
      get :search
    }
  end
end`)).toEqual(['GET /photos/:id/preview | photos#preview', 'GET /photos/search | photos#search', 'POST /photos/:id/crop | photos#crop']);
  });
  it('hash literals ending in { do not swallow a following block', () => {
    expect(lab(`Rails.application.routes.draw do
  opts = {
    a: 1
  }
  resources :tags, only: [:index] do
    get :x, on: :collection
  end
end`)).toEqual(['GET /tags | tags#index', 'GET /tags/x | tags#x']);
  });
  it('irregular plurals: nested resources under people use person_id', () => {
    expect(lab(`Rails.application.routes.draw do
  resources :people, only: [:show] do
    resources :children, only: [:index]
  end
  resources :categories, only: [] do
    resources :analyses, only: [:index]
  end
end`)).toEqual(['GET /categories/:category_id/analyses | analyses#index', 'GET /people/:id | people#show', 'GET /people/:person_id/children | children#index']);
  });
  it('singular resource controller is the plural of the name, incl. irregular', () => {
    expect(lab(`Rails.application.routes.draw do
  resource :person, only: [:show]
end`)).toEqual(['GET /person | people#show']);
  });
});

describe('rails: shallow, devise_for, draw', () => {
  const labels = (g: { nodes: Array<{ kind?: string; label: string }> }) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('shallow nesting keeps member routes un-nested', () => {
    const g = analyzeRubyRoutes([{ path: 'config/routes.rb', text: `Rails.application.routes.draw do\n  resources :articles, only: [:index] do\n    shallow do\n      resources :comments, only: [:index, :show]\n    end\n  end\nend` }]);
    expect(labels(g)).toEqual(['GET /articles | articles#index', 'GET /articles/:article_id/comments | comments#index', 'GET /comments/:id | comments#show']);
  });
  it('shallow: true option', () => {
    const g = analyzeRubyRoutes([{ path: 'config/routes.rb', text: `Rails.application.routes.draw do\n  resources :a, only: [], shallow: true do\n    resources :bs, only: [:new, :edit]\n  end\nend` }]);
    expect(labels(g)).toEqual(['GET /a/:a_id/bs/new | bs#new', 'GET /bs/:id/edit | bs#edit']);
  });
  it('devise_for reads modules from the scanned model', () => {
    const g = analyzeRubyRoutes([
      { path: 'config/routes.rb', text: `Rails.application.routes.draw do\n  devise_for :users, controllers: { sessions: 'users/sessions' }\nend` },
      { path: 'app/models/user.rb', text: `class User < ApplicationRecord\n  devise :database_authenticatable, :confirmable\nend` },
    ]);
    expect(labels(g)).toEqual(['DELETE /users/sign_out | users/sessions#destroy', 'GET /users/confirmation | devise/confirmations#show', 'GET /users/confirmation/new | devise/confirmations#new', 'GET /users/sign_in | users/sessions#new', 'POST /users/confirmation | devise/confirmations#create', 'POST /users/sign_in | users/sessions#create']);
  });
  it('draw :file inlines config/routes/file.rb inside the surrounding scope', () => {
    const g = analyzeRubyRoutes([
      { path: 'config/routes.rb', text: `Rails.application.routes.draw do\n  namespace :admin do\n    draw :users\n  end\nend` },
      { path: 'config/routes/users.rb', text: `resources :users, only: [:index]\n` },
    ]);
    expect(labels(g)).toEqual(['GET /admin/users | admin/users#index']);
  });
});
