/*
===========================================================================
Copyright (C) 1999-2005 Id Software, Inc.

This file is part of Quake III Arena source code.

Quake III Arena source code is free software; you can redistribute it
and/or modify it under the terms of the GNU General Public License as
published by the Free Software Foundation; either version 2 of the License,
or (at your option) any later version.

Quake III Arena source code is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Foobar; if not, write to the Free Software
Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
===========================================================================
*/
// light.c

#include "light.h"
#if defined(_WIN32) && defined(OMMAP_PAK)	// the editor's pak and JPEG readers, left out
#ifdef _TTIMOBUILD
#include "pakstuff.h"
#else
#include "libs/pakstuff.h"
#endif
#endif


#define	EXTRASCALE	2

typedef struct {
	float		plane[4];
	vec3_t		origin;
	vec3_t		vectors[2];
	shaderInfo_t	*si;
} filter_t;

#define	MAX_FILTERS	1024
filter_t	filters[MAX_FILTERS];
int			numFilters;

extern char	source[1024];

qboolean	notrace;
qboolean	patchshadows;
qboolean	dump;
qboolean	extra;
qboolean	extraWide;
qboolean	lightmapBorder;

qboolean	noSurfaces;

int			samplesize = 32;		//sample size in units: 32, as in the game's maps
int			novertexlighting = 0;
int			nogridlighting = 0;

// for run time tweaking of all area sources in the level
float		areaScale =	0.25;

// for run time tweaking of all point sources in the level
float		pointScale = 7500;
float		sunScale = 1, skyScale = 1;
qboolean	noDiffuseSun;				// -nodiffusesun: no sky light, the sun 1.3 times as bright		// -sunscale, -skyscale: the light step's own scales

qboolean	exactPointToPolygon = qtrue;

float		formFactorValueScale = 3;

float		linearScale = 1.0 / 8000;
// the game's lightmaps are lit 1.25 times as brightly by lights as q3map lights them (EA's
// mohdm6 and m4l0, texel for texel); the light grid and static models are not
float		surfaceLightScale = 1.25f;

light_t		*lights;
int			numPointLights;
int			numAreaLights;

FILE		*dumpFile;

int			c_visible, c_occluded;

//int			defaultLightSubdivide = 128;		// vary by surface size?
int			defaultLightSubdivide = 999;		// vary by surface size?

vec3_t		ambientColor;

vec3_t		surfaceOrigin[ MAX_MAP_DRAW_SURFS ];
int			entitySurface[ MAX_MAP_DRAW_SURFS ];

// 7,9,11 normalized to avoid being nearly coplanar with common faces
//vec3_t		sunDirection = { 0.441835, 0.56807, 0.694313 };
//vec3_t		sunDirection = { 0.45, 0, 0.9 };
//vec3_t		sunDirection = { 0, 0, 1 };

// these are usually overrided by shader values
vec3_t		sunDirection = { 0.45, 0.3, 0.9 };
vec3_t		sunLight = { 100, 100, 50 };



typedef struct {
	dbrush_t	*b;
	vec3_t		bounds[2];
} skyBrush_t;

int			numSkyBrushes;
skyBrush_t	skyBrushes[MAX_MAP_BRUSHES];


/*

the corners of a patch mesh will always be exactly at lightmap samples.
The dimensions of the lightmap will be equal to the average length of the control
mesh in each dimension divided by 2.
The lightmap sample points should correspond to the chosen subdivision points.

*/

/*
===============================================================

SURFACE LOADING

===============================================================
*/

#define	MAX_FACE_POINTS		128

/*
===============
SubdivideAreaLight

Subdivide area lights that are very large
A light that is subdivided will never backsplash, avoiding weird pools of light near edges
===============
*/
void SubdivideAreaLight( shaderInfo_t *ls, winding_t *w, vec3_t normal, 
						float areaSubdivide, qboolean backsplash ) {
	float			area, value, intensity;
	light_t			*dl, *dl2;
	vec3_t			mins, maxs;
	int				axis;
	winding_t		*front, *back;
	vec3_t			planeNormal;
	float			planeDist;

	if ( !w ) {
		return;
	}

	WindingBounds( w, mins, maxs );

	// check for subdivision
	for ( axis = 0 ; axis < 3 ; axis++ ) {
		if ( maxs[axis] - mins[axis] > areaSubdivide ) {
			VectorClear( planeNormal );
			planeNormal[axis] = 1;
			planeDist = ( maxs[axis] + mins[axis] ) * 0.5;
			ClipWindingEpsilon ( w, planeNormal, planeDist, ON_EPSILON, &front, &back );
			SubdivideAreaLight( ls, front, normal, areaSubdivide, qfalse );
			SubdivideAreaLight( ls, back, normal, areaSubdivide, qfalse );
			FreeWinding( w );
			return;
		}
	}

	// create a light from this
	area = WindingArea (w);
	if ( area <= 0 || area > 20000000 ) {
		return;
	}

	numAreaLights++;
	dl = malloc(sizeof(*dl));
	memset (dl, 0, sizeof(*dl));
	dl->next = lights;
	lights = dl;
	dl->type = emit_area;

	WindingCenter( w, dl->origin );
	dl->w = w;
	VectorCopy ( normal, dl->normal);
	dl->dist = DotProduct( dl->origin, normal );

	value = ls->value;
	intensity = value * area * areaScale;
	VectorAdd( dl->origin, dl->normal, dl->origin );

	VectorCopy( ls->color, dl->color );

	dl->photons = intensity;

	// emitColor is irrespective of the area
	VectorScale( ls->color, value*formFactorValueScale*areaScale, dl->emitColor );

	dl->si = ls;

	if ( ls->contents & CONTENTS_FOG ) {
		dl->twosided = qtrue;
	}

	// optionally create a point backsplash light
	if ( backsplash && ls->backsplashFraction > 0 ) {
		dl2 = malloc(sizeof(*dl));
		memset (dl2, 0, sizeof(*dl2));
		dl2->next = lights;
		lights = dl2;
		dl2->type = emit_point;

		VectorMA( dl->origin, ls->backsplashDistance, normal, dl2->origin );

		VectorCopy( ls->color, dl2->color );

		dl2->photons = dl->photons * ls->backsplashFraction;
		dl2->si = ls;
	}
}


/*
===============
CountLightmaps
===============
*/
void CountLightmaps( void ) {
	int			count;
	int			i;
	dsurface_t	*ds;

	qprintf ("--- CountLightmaps ---\n");
	count = 0;
	for ( i = 0 ; i < numDrawSurfaces ; i++ ) {
		// see if this surface is light emiting
		ds = &drawSurfaces[i];
		if ( ds->lightmapNum > count ) {
			count = ds->lightmapNum;
		}
	}

	count++;
	numLightBytes = count * LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3;
	if ( numLightBytes > MAX_MAP_LIGHTING ) {
		Error("MAX_MAP_LIGHTING exceeded");
	}

	qprintf( "%5i drawSurfaces\n", numDrawSurfaces );
	qprintf( "%5i lightmaps\n", count );
}

/*
===============
CreateSurfaceLights

This creates area lights
===============
*/
void CreateSurfaceLights( void ) {
	int				i, j, side;
	dsurface_t		*ds;
	shaderInfo_t	*ls;
	winding_t		*w;
	cFacet_t		*f;
	light_t			*dl;
	vec3_t			origin;
	drawVert_t		*dv;
	int				c_lightSurfaces;
	float			lightSubdivide;
	vec3_t			normal;

	qprintf ("--- CreateSurfaceLights ---\n");
	c_lightSurfaces = 0;

	for ( i = 0 ; i < numDrawSurfaces ; i++ ) {
		// see if this surface is light emiting
		ds = &drawSurfaces[i];

		ls = ShaderInfoForShader( dshaders[ ds->shaderNum].shader );
		if ( ls->value == 0 ) {
			continue;
		}

		// determine how much we need to chop up the surface
		if ( ls->lightSubdivide ) {
			lightSubdivide = ls->lightSubdivide;
		} else {
			lightSubdivide = defaultLightSubdivide;
		}

		c_lightSurfaces++;

		// an autosprite shader will become
		// a point light instead of an area light
		if ( ls->autosprite ) {
			// autosprite geometry should only have four vertexes
			if ( surfaceTest[i] ) {
				// curve or misc_model
				f = surfaceTest[i]->facets;
				if ( surfaceTest[i]->numFacets != 1 || f->numBoundaries != 4 ) {
					_printf( "WARNING: surface at (%i %i %i) has autosprite shader but isn't a quad\n",
						(int)f->points[0], (int)f->points[1], (int)f->points[2] );
				}
				VectorAdd( f->points[0], f->points[1], origin );
				VectorAdd( f->points[2], origin, origin );
				VectorAdd( f->points[3], origin, origin );
				VectorScale( origin, 0.25, origin );
			} else {
				// normal polygon
				dv = &drawVerts[ ds->firstVert ];
				if ( ds->numVerts != 4 ) {
					_printf( "WARNING: surface at (%i %i %i) has autosprite shader but %i verts\n",
						(int)dv->xyz[0], (int)dv->xyz[1], (int)dv->xyz[2] );
					continue;
				}

				VectorAdd( dv[0].xyz, dv[1].xyz, origin );
				VectorAdd( dv[2].xyz, origin, origin );
				VectorAdd( dv[3].xyz, origin, origin );
				VectorScale( origin, 0.25, origin );
			}


			numPointLights++;
			dl = malloc(sizeof(*dl));
			memset (dl, 0, sizeof(*dl));
			dl->next = lights;
			lights = dl;

			VectorCopy( origin, dl->origin );
			VectorCopy( ls->color, dl->color );
			dl->photons = ls->value * pointScale;
			dl->type = emit_point;
			continue;
		}

		// possibly create for both sides of the polygon
		for ( side = 0 ; side <= ls->twoSided ; side++ ) {
			// create area lights
			if ( surfaceTest[i] ) {
				// curve or misc_model
				for ( j = 0 ; j < surfaceTest[i]->numFacets ; j++ ) {
					f = surfaceTest[i]->facets + j;
					w = AllocWinding( f->numBoundaries );
					w->numpoints = f->numBoundaries;
					memcpy( w->p, f->points, f->numBoundaries * 12 );

					VectorCopy( f->surface, normal );
					if ( side ) {
						winding_t	*t;

						t = w;
						w = ReverseWinding( t );
						FreeWinding( t );
						VectorSubtract( vec3_origin, normal, normal );
					}
					SubdivideAreaLight( ls, w, normal, lightSubdivide, qtrue );
				}
			} else {
				// normal polygon

				w = AllocWinding( ds->numVerts );
				w->numpoints = ds->numVerts;
				for ( j = 0 ; j < ds->numVerts ; j++ ) {
					VectorCopy( drawVerts[ds->firstVert+j].xyz, w->p[j] );
				}
				VectorCopy( ds->lightmapVecs[2], normal );
				if ( side ) {
					winding_t	*t;

					t = w;
					w = ReverseWinding( t );
					FreeWinding( t );
					VectorSubtract( vec3_origin, normal, normal );
				}
				SubdivideAreaLight( ls, w, normal, lightSubdivide, qtrue );
			}
		}
	}

	_printf( "%5i light emitting surfaces\n", c_lightSurfaces );
}



/*
================
FindSkyBrushes
================
*/
void FindSkyBrushes( void ) {
	int				i, j;
	dbrush_t		*b;
	skyBrush_t		*sb;
	shaderInfo_t	*si;
	dbrushside_t	*s;

	// find the brushes
	for ( i = 0 ; i < numbrushes ; i++ ) {
		b = &dbrushes[i];
		for ( j = 0 ; j < b->numSides ; j++ ) {
			s = &dbrushsides[ b->firstSide + j ];
			if ( dshaders[ s->shaderNum ].surfaceFlags & SURF_SKY ) {
				sb = &skyBrushes[ numSkyBrushes ];
				sb->b = b;
				sb->bounds[0][0] = -dplanes[ dbrushsides[ b->firstSide + 0 ].planeNum ].dist - 1;
				sb->bounds[1][0] = dplanes[ dbrushsides[ b->firstSide + 1 ].planeNum ].dist + 1;
				sb->bounds[0][1] = -dplanes[ dbrushsides[ b->firstSide + 2 ].planeNum ].dist - 1;
				sb->bounds[1][1] = dplanes[ dbrushsides[ b->firstSide + 3 ].planeNum ].dist + 1;
				sb->bounds[0][2] = -dplanes[ dbrushsides[ b->firstSide + 4 ].planeNum ].dist - 1;
				sb->bounds[1][2] = dplanes[ dbrushsides[ b->firstSide + 5 ].planeNum ].dist + 1;
				numSkyBrushes++;
				break;
			}
		}
	}

	// default
	VectorNormalize( sunDirection, sunDirection );

	// find the sky shader
	for ( i = 0 ; i < numDrawSurfaces ; i++ ) {
		si = ShaderInfoForShader( dshaders[ drawSurfaces[i].shaderNum ].shader );
		if ( si->surfaceFlags & SURF_SKY ) {
			VectorCopy( si->sunLight, sunLight );
			VectorCopy( si->sunDirection, sunDirection );
			break;
		}
	}
}

/*
=================================================================

  LIGHT SETUP

=================================================================
*/

/*
==================
FindTargetEntity
==================
*/
entity_t *FindTargetEntity( const char *target ) {
	int			i;
	const char	*n;

	for ( i = 0 ; i < num_entities ; i++ ) {
		n = ValueForKey (&entities[i], "targetname");
		if ( !strcmp (n, target) ) {
			return &entities[i];
		}
	}

	return NULL;
}



/*
=============
CreateEntityLights
=============
*/
void CreateEntityLights (void)
{
	int		i;
	light_t	*dl;
	entity_t	*e, *e2;
	const char	*name;
	const char	*target;
	vec3_t	dest;
	const char	*_color;
	float	intensity;
	int		spawnflags;

	//
	// entities
	//
	for ( i = 0 ; i < num_entities ; i++ ) {
		e = &entities[i];
		name = ValueForKey (e, "classname");
		if (strncmp (name, "light", 5))
			continue;

		numPointLights++;
		dl = malloc(sizeof(*dl));
		memset (dl, 0, sizeof(*dl));
		dl->next = lights;
		lights = dl;

		spawnflags = FloatForKey (e, "spawnflags");
		if ( spawnflags & 1 ) {
			dl->linearLight = qtrue;
		}

		GetVectorForKey (e, "origin", dl->origin);
		dl->style = FloatForKey (e, "_style");
		if (!dl->style)
			dl->style = FloatForKey (e, "style");
		if (dl->style < 0)
			dl->style = 0;

		intensity = FloatForKey (e, "light");
		if (!intensity)
			intensity = FloatForKey (e, "_light");
		if (!intensity)
			intensity = 300;
		_color = ValueForKey (e, "_color");
		if (_color && _color[0])
		{
			sscanf (_color, "%f %f %f", &dl->color[0],&dl->color[1],&dl->color[2]);
			ColorNormalize (dl->color, dl->color);
		}
		else
			dl->color[0] = dl->color[1] = dl->color[2] = 1.0;

		intensity = intensity * pointScale;
		dl->photons = intensity;

		dl->type = emit_point;

		// lights with a target will be spotlights
		target = ValueForKey (e, "target");

		if ( target[0] ) {
			float	radius;
			float	dist;

			e2 = FindTargetEntity (target);
			if (!e2) {
				_printf ("WARNING: light at (%i %i %i) has missing target\n",
				(int)dl->origin[0], (int)dl->origin[1], (int)dl->origin[2]);
			} else {
				GetVectorForKey (e2, "origin", dest);
				VectorSubtract (dest, dl->origin, dl->normal);
				dist = VectorNormalize (dl->normal, dl->normal);
				radius = FloatForKey (e, "radius");
				if ( !radius ) {
					radius = 64;
				}
				if ( !dist ) {
					dist = 64;
				}
				dl->radiusByDist = (radius + 16) / dist;
				dl->type = emit_spotlight;
			}
		} else if ( ValueForKey( e, "angles" )[0] || ValueForKey( e, "radius" )[0] ) {
			// MoHAA's spotlight: "angles" (pitch yaw) aim it, "radius" is the cone's radius
			// 64 units away (the game's maps: radius 90 is a spot of (90 + 16) / 64)
			vec3_t	ang;
			float	radius;
			double	p, y;

			VectorClear( ang );
			if ( ValueForKey( e, "angles" )[0] ) {
				GetVectorForKey( e, "angles", ang );
			} else {
				ang[1] = FloatForKey( e, "angle" );
			}
			p = ang[0] * Q_PI / 180.0;
			y = ang[1] * Q_PI / 180.0;
			dl->normal[0] = cos( p ) * cos( y );
			dl->normal[1] = cos( p ) * sin( y );
			dl->normal[2] = -sin( p );
			radius = FloatForKey( e, "radius" );
			if ( !radius ) {
				radius = 64;
			}
			dl->radiusByDist = ( radius + 16 ) / 64;
			dl->type = emit_spotlight;
		}
	}
}

//=================================================================

/*
================
SetEntityOrigins

Find the offset values for inline models
================
*/
void SetEntityOrigins( void ) {
	int			i, j;
	entity_t	*e;
	vec3_t		origin;
	const char	*key;
	int			modelnum;
	dmodel_t	*dm;

	for ( i=0 ; i < num_entities ; i++ ) {
		e = &entities[i];
		key = ValueForKey (e, "model");
		if ( key[0] != '*' ) {
			continue;
		}
		modelnum = atoi( key + 1 );
		dm = &dmodels[ modelnum ];

		// set entity surface to true for all surfaces for this model
		for ( j = 0 ; j < dm->numSurfaces ; j++ ) {
			entitySurface[ dm->firstSurface + j ] = qtrue;
		}

		key = ValueForKey (e, "origin");
		if ( !key[0] ) {
			continue;
		}
		GetVectorForKey ( e, "origin", origin );

		// set origin for all surfaces for this model
		for ( j = 0 ; j < dm->numSurfaces ; j++ ) {
			VectorCopy( origin, surfaceOrigin[ dm->firstSurface + j ] );
		}
	}
}


/*
=================================================================


=================================================================
*/

#define	MAX_POINTS_ON_WINDINGS	64

/*
================
PointToPolygonFormFactor
================
*/
float	PointToPolygonFormFactor( const vec3_t point, const vec3_t normal, const winding_t *w ) {
	vec3_t		triVector, triNormal;
	int			i, j;
	vec3_t		dirs[MAX_POINTS_ON_WINDING];
	float		total;
	float		dot, angle, facing;

	for ( i = 0 ; i < w->numpoints ; i++ ) {
		VectorSubtract( w->p[i], point, dirs[i] );
		VectorNormalize( dirs[i], dirs[i] );
	}

	// duplicate first vertex to avoid mod operation
	VectorCopy( dirs[0], dirs[i] );

	total = 0;
	for ( i = 0 ; i < w->numpoints ; i++ ) {
		j = i+1;
		dot = DotProduct( dirs[i], dirs[j] );

		// roundoff can cause slight creep, which gives an IND from acos
		if ( dot > 1.0 ) {
			dot = 1.0;
		} else if ( dot < -1.0 ) {
			dot = -1.0;
		}
		
		angle = acos( dot );
		CrossProduct( dirs[i], dirs[j], triVector );
		if ( VectorNormalize( triVector, triNormal ) < 0.0001 ) {
			continue;
		}
		facing = DotProduct( normal, triNormal );
		total += facing * angle;

		if ( total > 6.3 || total < -6.3 ) {
			static qboolean printed;

			if ( !printed ) {
				printed = qtrue;
				_printf( "WARNING: bad PointToPolygonFormFactor: %f at %1.1f %1.1f %1.1f from %1.1f %1.1f %1.1f\n", total,
					w->p[i][0], w->p[i][1], w->p[i][2], point[0], point[1], point[2]);
			}
			return 0;
		}

	}

	total /= 2*3.141592657;		// now in the range of 0 to 1 over the entire incoming hemisphere

	return total;
}


/*
================
FilterTrace

Returns 0 to 1.0 filter fractions for the given trace
================
*/
void	FilterTrace( const vec3_t start, const vec3_t end, vec3_t filter ) {
	float		d1, d2;
	filter_t	*f;
	int			filterNum;
	vec3_t		point;
	float		frac;
	int			i;
	float		s, t;
	int			u, v;
	int			x, y;
	byte		*pixel;
	float		radius;
	float		len;
	vec3_t		total;

	filter[0] = 1.0;
	filter[1] = 1.0;
	filter[2] = 1.0;

	for ( filterNum = 0 ; filterNum < numFilters ; filterNum++ ) {
		f = &filters[ filterNum ];

		// see if the plane is crossed
		d1 = DotProduct( start, f->plane ) - f->plane[3];
		d2 = DotProduct( end, f->plane ) - f->plane[3];

		if ( ( d1 < 0 ) == ( d2 < 0 ) ) {
			continue;
		}

		// calculate the crossing point
		frac = d1 / ( d1 - d2 );

		for ( i = 0 ; i < 3 ; i++ ) {
			point[i] = start[i] + frac * ( end[i] - start[i] );
		}

		VectorSubtract( point, f->origin, point );

		s = DotProduct( point, f->vectors[0] );
		t = 1.0 - DotProduct( point, f->vectors[1] );
		if ( s < 0 || s >= 1.0 || t < 0 || t >= 1.0 ) {
			continue;
		}

		// decide the filter size
		radius = 10 * frac;
		len = VectorLength( f->vectors[0] );
		if ( !len ) {
			continue;
		}
		radius = radius * len * f->si->width;

		// look up the filter, taking multiple samples
		VectorClear( total );
		for ( u = -1 ; u <= 1 ; u++ ) {
			for ( v = -1 ; v <=1 ; v++ ) {
				x = s * f->si->width + u * radius;
				if ( x < 0 ) {
					x = 0;
				}
				if ( x >= f->si->width ) {
					x = f->si->width - 1;
				}
				y = t * f->si->height + v * radius;
				if ( y < 0 ) {
					y = 0;
				}
				if ( y >= f->si->height ) {
					y = f->si->height - 1;
				}

				pixel = f->si->pixels + ( y * f->si->width + x ) * 4;
				total[0] += pixel[0];
				total[1] += pixel[1];
				total[2] += pixel[2];
			}
		}

		filter[0] *= total[0]/(255.0*9);
		filter[1] *= total[1]/(255.0*9);
		filter[2] *= total[2]/(255.0*9);
	}

}

/*
================
SunToPoint

Returns an amount of light to add at the point
================
*/
int		c_sunHit, c_sunMiss;
void SunToPoint( const vec3_t origin, traceWork_t *tw, vec3_t addLight ) {
	int			i;
	trace_t		trace;
	skyBrush_t	*b;
	vec3_t		end;

	if ( !numSkyBrushes ) {
		VectorClear( addLight );
		return;
	}

	VectorMA( origin, MAX_WORLD_COORD * 2, sunDirection, end );

	TraceLine( origin, end, &trace, qtrue, tw );

	// see if trace.hit is inside a sky brush
	for ( i = 0 ; i < numSkyBrushes ; i++) {
		b = &skyBrushes[ i ];

		// this assumes that sky brushes are axial...
		if (   trace.hit[0] < b->bounds[0][0] 
			|| trace.hit[0] > b->bounds[1][0]
			|| trace.hit[1] < b->bounds[0][1]
			|| trace.hit[1] > b->bounds[1][1]
			|| trace.hit[2] < b->bounds[0][2]
			|| trace.hit[2] > b->bounds[1][2] ) {
			continue;
		}


		// trace again to get intermediate filters
		TraceLine( origin, trace.hit, &trace, qtrue, tw );

		// we hit the sky, so add sunlight
		if ( numthreads == 1 ) {
			c_sunHit++;
		}
		addLight[0] = trace.filter[0] * sunLight[0];
		addLight[1] = trace.filter[1] * sunLight[1];
		addLight[2] = trace.filter[2] * sunLight[2];

		return;
	}

	if ( numthreads == 1 ) {
		c_sunMiss++;
	}

	VectorClear( addLight );
}

/*
================
SkyFilterAlong

Whether a ray from origin along dir reaches a sky brush; the light let through on the
way (1 1 1 when nothing in between filters it) goes to filter.
================
*/
qboolean SkyFilterAlong( const vec3_t origin, const vec3_t dir, traceWork_t *tw, vec3_t filter ) {
	int			i;
	trace_t		trace;
	skyBrush_t	*b;
	vec3_t		end;

	if ( !numSkyBrushes ) {
		return qfalse;
	}
	VectorMA( origin, MAX_WORLD_COORD * 2, dir, end );
	TraceLine( origin, end, &trace, qtrue, tw );
	for ( i = 0 ; i < numSkyBrushes ; i++ ) {
		b = &skyBrushes[ i ];
		if (   trace.hit[0] < b->bounds[0][0] || trace.hit[0] > b->bounds[1][0]
			|| trace.hit[1] < b->bounds[0][1] || trace.hit[1] > b->bounds[1][1]
			|| trace.hit[2] < b->bounds[0][2] || trace.hit[2] > b->bounds[1][2] ) {
			continue;
		}
		TraceLine( origin, trace.hit, &trace, qtrue, tw );
		VectorCopy( trace.filter, filter );
		return qtrue;
	}
	return qfalse;
}

/*
================
SkyDiffuseToPoint

MoHAA's "sundiffuse": light from the whole sky, "sundiffusecolor" (0-255) times the
part of the sky seen. With a normal, the rays fan over the half facing it, weighted
by the angle as light on a surface is; without one (the light grid), over the upper
half, each ray alike.
================
*/
#define SKY_RAYS	16		// rays per surface sample (the grid's points take every other one)
vec3_t		skyDiffuseColor;
float		skyDiffuse;
static vec3_t	skyRays[SKY_RAYS];
static int		skyRaysMade;

static void MakeSkyRays( void ) {
	int		i;
	double	golden = Q_PI * ( 3.0 - sqrt( 5.0 ) );

	// a spiral of even directions over the upper half
	for ( i = 0 ; i < SKY_RAYS ; i++ ) {
		double z = 1.0 - ( i + 0.5 ) / SKY_RAYS;
		double r = sqrt( 1.0 - z * z );
		skyRays[i][0] = r * cos( golden * i );
		skyRays[i][1] = r * sin( golden * i );
		skyRays[i][2] = z;
	}
	skyRaysMade = 1;
}

// EA's MOHlight's sky directions (MOHlight.exe's data at 0x44b908): 92 unit vectors
static const float eaSkyRays[92][3] = {
	{ 0.0f, 0.0f, 1.0f },
	{ 0.894427001f, 0.0f, 0.447214007f },
	{ 0.276392996f, 0.850651026f, 0.447214007f },
	{ -0.723607004f, 0.525731027f, 0.447214007f },
	{ -0.723607004f, -0.525731027f, 0.447214007f },
	{ 0.276392996f, -0.850651026f, 0.447214007f },
	{ 0.723607004f, 0.525731027f, -0.447214007f },
	{ -0.276392996f, 0.850651026f, -0.447214007f },
	{ -0.894427001f, 0.0f, -0.447214007f },
	{ -0.276392996f, -0.850651026f, -0.447214007f },
	{ 0.723607004f, -0.525731027f, -0.447214007f },
	{ 0.0f, 0.0f, -1.0f },
	{ 0.348482013f, 0.0f, 0.937314987f },
	{ 0.678525984f, 0.0f, 0.734575987f },
	{ 0.107686996f, 0.331427008f, 0.937314987f },
	{ 0.209675997f, 0.645317018f, 0.734575987f },
	{ -0.281928003f, 0.204833001f, 0.937314987f },
	{ -0.548940003f, 0.398828f, 0.734575987f },
	{ -0.281928003f, -0.204833001f, 0.937314987f },
	{ -0.54893899f, -0.398828f, 0.734575987f },
	{ 0.107686996f, -0.331427008f, 0.937314987f },
	{ 0.209675997f, -0.645317018f, 0.734575987f },
	{ 0.787855029f, 0.336140007f, 0.516036987f },
	{ 0.563148022f, 0.645421982f, 0.516036987f },
	{ -0.0762270018f, 0.853168011f, 0.516036987f },
	{ -0.439810008f, 0.735032022f, 0.516036987f },
	{ -0.834966004f, 0.191147f, 0.516036987f },
	{ -0.834966004f, -0.191147f, 0.516036987f },
	{ -0.439810008f, -0.735032022f, 0.516036987f },
	{ -0.0762270018f, -0.853168011f, 0.516036987f },
	{ 0.563148022f, -0.645421982f, 0.516036987f },
	{ 0.787855029f, -0.336140007f, 0.516036987f },
	{ 0.964049995f, 0.207753003f, 0.165669993f },
	{ 0.902046978f, 0.398579001f, -0.165669993f },
	{ 0.100322999f, 0.981064975f, 0.165669993f },
	{ -0.100323997f, 0.981064975f, -0.165669993f },
	{ -0.902046978f, 0.398579001f, 0.165669993f },
	{ -0.964049995f, 0.207752004f, -0.165669993f },
	{ -0.657818973f, -0.734730005f, 0.165669993f },
	{ -0.495492011f, -0.852666974f, -0.165669993f },
	{ 0.495492011f, -0.852666974f, 0.165669993f },
	{ 0.657818973f, -0.734730005f, -0.165669993f },
	{ 0.964049995f, -0.207752004f, 0.165669993f },
	{ 0.902046978f, -0.398579001f, -0.165669993f },
	{ 0.495492011f, 0.852666974f, 0.165669993f },
	{ 0.657818973f, 0.734730005f, -0.165669993f },
	{ -0.657818973f, 0.734730005f, 0.165669993f },
	{ -0.495492011f, 0.852666974f, -0.165669993f },
	{ -0.902046978f, -0.398579001f, 0.165669993f },
	{ -0.964049995f, -0.207752004f, -0.165669993f },
	{ 0.100323997f, -0.981064975f, 0.165669993f },
	{ -0.100322999f, -0.981064975f, -0.165669993f },
	{ 0.439810008f, 0.735032022f, -0.516036987f },
	{ 0.0762270018f, 0.853168011f, -0.516036987f },
	{ -0.563148022f, 0.645421982f, -0.516036987f },
	{ -0.787855029f, 0.336140007f, -0.516036987f },
	{ -0.787855029f, -0.336140007f, -0.516036987f },
	{ -0.563148022f, -0.645421982f, -0.516036987f },
	{ 0.0762270018f, -0.853168011f, -0.516036987f },
	{ 0.439810008f, -0.735032022f, -0.516036987f },
	{ 0.834966004f, -0.191147f, -0.516036987f },
	{ 0.834966004f, 0.191147f, -0.516036987f },
	{ 0.281928003f, 0.204833001f, -0.937314987f },
	{ 0.54893899f, 0.398828f, -0.734575987f },
	{ -0.107686996f, 0.331427008f, -0.937314987f },
	{ -0.209675997f, 0.645317018f, -0.734575987f },
	{ -0.348482013f, 0.0f, -0.937314987f },
	{ -0.678525984f, 0.0f, -0.734575987f },
	{ -0.107686996f, -0.331427008f, -0.937314987f },
	{ -0.209675997f, -0.645317018f, -0.734575987f },
	{ 0.281928003f, -0.204833001f, -0.937314987f },
	{ 0.548940003f, -0.398828f, -0.734575987f },
	{ 0.487302005f, 0.354045987f, 0.798240006f },
	{ -0.186132997f, 0.572857976f, 0.798240006f },
	{ -0.602339029f, 0.0f, 0.798240006f },
	{ -0.186132997f, -0.572857976f, 0.798240006f },
	{ 0.487302989f, -0.354045987f, 0.798240006f },
	{ 0.983341992f, 0.0f, -0.181764007f },
	{ 0.303869009f, 0.935213983f, -0.181765005f },
	{ -0.795540988f, 0.577993989f, -0.181764007f },
	{ -0.795539975f, -0.577993989f, -0.181764007f },
	{ 0.303869992f, -0.935213983f, -0.181764007f },
	{ 0.795540988f, 0.577993989f, 0.181764007f },
	{ -0.303869992f, 0.935213983f, 0.181764007f },
	{ -0.983341992f, 0.0f, 0.181765005f },
	{ -0.303869009f, -0.935213983f, 0.181764007f },
	{ 0.795540988f, -0.577993989f, 0.181764007f },
	{ 0.186132997f, 0.572857976f, -0.798240006f },
	{ -0.487302989f, 0.354045987f, -0.798240006f },
	{ -0.487302005f, -0.354045987f, -0.798240006f },
	{ 0.186132997f, -0.572857976f, -0.798240006f },
	{ 0.602339029f, 0.0f, -0.798240006f }
};

void SkyDiffuseToPoint( const vec3_t origin, const float *normal, traceWork_t *tw, vec3_t color ) {
	int		i;
	vec3_t	dir, filter, sum, t1, t2;
	float	w, wsum = 0;

	if ( skyDiffuse <= 0 || !numSkyBrushes ) {
		return;
	}
	if ( normal ) {
		// a surface sample, as EA's MOHlight lights it (0x4281d0): from a unit off the
		// surface, each of its 92 directions at most 0.3 below the horizon that faces the
		// surface (every other one counted twice; with -extra, each once) and reaches the
		// sky adds the sky's colour * sundiffuse * 2.3 / 92 * (1 + cos) / 2. An open floor
		// gets 1.07 times the sky's colour (EA's own light step on a test map: the same)
		vec3_t	start;
		float	k = skyDiffuse * 2.3f / 92.0f, d;
		int		step = extra ? 1 : 2;
		VectorAdd( origin, normal, start );
		for ( i = 0 ; i < 92 ; i += step ) {
			if ( eaSkyRays[i][2] < -0.3f ) {
				continue;
			}
			d = DotProduct( normal, eaSkyRays[i] );
			if ( d <= 0 ) {
				continue;
			}
			if ( SkyFilterAlong( start, eaSkyRays[i], tw, filter ) ) {
				w = ( 0.5f + 0.5f * d ) * step * k;
				color[0] += w * skyDiffuseColor[0] * filter[0];
				color[1] += w * skyDiffuseColor[1] * filter[1];
				color[2] += w * skyDiffuseColor[2] * filter[2];
			}
		}
		return;
	}
	if ( !skyRaysMade ) {
		MakeSkyRays();
	}
	VectorClear( sum );
	if ( normal ) {
		// two directions across the normal
		vec3_t	a;
		if ( fabs( normal[2] ) < 0.9f ) {
			a[0] = 0; a[1] = 0; a[2] = 1;
		} else {
			a[0] = 1; a[1] = 0; a[2] = 0;
		}
		CrossProduct( a, normal, t1 );
		VectorNormalize( t1, t1 );
		CrossProduct( normal, t1, t2 );
	}
	for ( i = normal ? 0 : 1 ; i < SKY_RAYS ; i += normal ? 1 : 2 ) {
		if ( normal ) {
			dir[0] = t1[0] * skyRays[i][0] + t2[0] * skyRays[i][1] + normal[0] * skyRays[i][2];
			dir[1] = t1[1] * skyRays[i][0] + t2[1] * skyRays[i][1] + normal[1] * skyRays[i][2];
			dir[2] = t1[2] * skyRays[i][0] + t2[2] * skyRays[i][1] + normal[2] * skyRays[i][2];
			w = skyRays[i][2];
		} else {
			VectorCopy( skyRays[i], dir );
			w = 1;
		}
		wsum += w;
		if ( SkyFilterAlong( origin, dir, tw, filter ) ) {
			VectorMA( sum, w, filter, sum );
		}
	}
	if ( wsum > 0 ) {
		color[0] += skyDiffuseColor[0] * skyDiffuse * sum[0] / wsum;
		color[1] += skyDiffuseColor[1] * skyDiffuse * sum[1] / wsum;
		color[2] += skyDiffuseColor[2] * skyDiffuse * sum[2] / wsum;
	}
}

/*
================
SunToPlane
================
*/
void SunToPlane( const vec3_t origin, const vec3_t normal, vec3_t color, traceWork_t *tw ) {
	float		angle;
	vec3_t		sunColor;

	if ( !numSkyBrushes ) {
		return;
	}

	angle = DotProduct( normal, sunDirection );
	if ( angle <= 0 ) {
		return;		// facing away
	}

	SunToPoint( origin, tw, sunColor );
	VectorMA( color, angle, sunColor, color );
}

/*
================
LightingAtSample
================
*/
void LightingAtSample( vec3_t origin, vec3_t normal, vec3_t color, 
					  qboolean testOcclusion, qboolean forceSunLight, traceWork_t *tw ) {
	light_t		*light;
	trace_t		trace;
	float		angle;
	float		add;
	float		dist;
	vec3_t		dir;

	VectorCopy( ambientColor, color );

	// trace to all the lights
	for ( light = lights ; light ; light = light->next ) {

		//MrE: if the light is behind the surface
		if ( DotProduct(light->origin, normal) - DotProduct(normal, origin) < 0 )
			continue;
		// testing exact PTPFF
		if ( exactPointToPolygon && light->type == emit_area ) {
			float		factor;
			float		d;
			vec3_t		pushedOrigin;

			// see if the point is behind the light
			d = DotProduct( origin, light->normal ) - light->dist;
			if ( !light->twosided ) {
				if ( d < -1 ) {
					continue;		// point is behind light
				}
			}

			// test occlusion and find light filters
			// clip the line, tracing from the surface towards the light
			if ( !notrace && testOcclusion ) {
				TraceLine( origin, light->origin, &trace, qfalse, tw );

				// other light rays must not hit anything
				if ( trace.passSolid ) {
					continue;
				}
			} else {
				trace.filter[0] = 1.0;
				trace.filter[1] = 1.0;
				trace.filter[2] = 1.0;
			}

			// nudge the point so that it is clearly forward of the light
			// so that surfaces meeting a light emiter don't get black edges
			if ( d > -8 && d < 8 ) {
				VectorMA( origin, (8-d), light->normal, pushedOrigin );	
			} else {
				VectorCopy( origin, pushedOrigin );
			}

			// calculate the contribution
			factor = PointToPolygonFormFactor( pushedOrigin, normal, light->w );
			if ( factor <= 0 ) {
				if ( light->twosided ) {
					factor = -factor;
				} else {
					continue;
				}
			}
			factor *= surfaceLightScale;
			color[0] += factor * light->emitColor[0] * trace.filter[0];
			color[1] += factor * light->emitColor[1] * trace.filter[1];
			color[2] += factor * light->emitColor[2] * trace.filter[2];

			continue;
		}

		// calculate the amount of light at this sample
		if ( light->type == emit_point ) {
			VectorSubtract( light->origin, origin, dir );
			dist = VectorNormalize( dir, dir );
			// clamp the distance to prevent super hot spots
			if ( dist < 16 ) {
				dist = 16;
			}
			angle = DotProduct( normal, dir );
			if ( light->linearLight ) {
				add = angle * light->photons * linearScale - dist;
				if ( add < 0 ) {
					add = 0;
				}
			} else {
				add = light->photons / ( dist * dist ) * angle;
			}
		} else if ( light->type == emit_spotlight ) {
			float	distByNormal;
			vec3_t	pointAtDist;
			float	radiusAtDist;
			float	sampleRadius;
			vec3_t	distToSample;
			float	coneScale;

			VectorSubtract( light->origin, origin, dir );

			distByNormal = -DotProduct( dir, light->normal );
			if ( distByNormal < 0 ) {
				continue;
			}
			VectorMA( light->origin, distByNormal, light->normal, pointAtDist );
			radiusAtDist = light->radiusByDist * distByNormal;

			VectorSubtract( origin, pointAtDist, distToSample );
			sampleRadius = VectorLength( distToSample );

			if ( sampleRadius >= radiusAtDist ) {
				continue;		// outside the cone
			}
			if ( sampleRadius <= radiusAtDist - 32 ) {
				coneScale = 1.0;	// fully inside
			} else {
				coneScale = ( radiusAtDist - sampleRadius ) / 32.0;
			}
			
			dist = VectorNormalize( dir, dir );
			// clamp the distance to prevent super hot spots
			if ( dist < 16 ) {
				dist = 16;
			}
			angle = DotProduct( normal, dir );
			add = light->photons / ( dist * dist ) * angle * coneScale;

		} else if ( light->type == emit_area ) {
			VectorSubtract( light->origin, origin, dir );
			dist = VectorNormalize( dir, dir );
			// clamp the distance to prevent super hot spots
			if ( dist < 16 ) {
				dist = 16;
			}
			angle = DotProduct( normal, dir );
			if ( angle <= 0 ) {
				continue;
			}
			angle *= -DotProduct( light->normal, dir );
			if ( angle <= 0 ) {
				continue;
			}

			if ( light->linearLight ) {
				add = angle * light->photons * linearScale - dist;
				if ( add < 0 ) {
					add = 0;
				}
			} else {
				add = light->photons / ( dist * dist ) * angle;
			}
		}

		if ( add <= 1.0 ) {
			continue;
		}

		// clip the line, tracing from the surface towards the light
		if ( !notrace && testOcclusion ) {
			TraceLine( origin, light->origin, &trace, qfalse, tw );

			// other light rays must not hit anything
			if ( trace.passSolid ) {
				continue;
			}
		} else {
			trace.filter[0] = 1;
			trace.filter[1] = 1;
			trace.filter[2] = 1;
		}
		
		// add the result
		add *= surfaceLightScale;
		color[0] += add * light->color[0] * trace.filter[0];
		color[1] += add * light->color[1] * trace.filter[1];
		color[2] += add * light->color[2] * trace.filter[2];
	}

	//
	// trace directly to the sun
	//
	if ( testOcclusion || forceSunLight ) {
		SunToPlane( origin, normal, color, tw );
		SkyDiffuseToPoint( origin, normal, tw, color );
	}
}

/*
=============
PrintOccluded

For debugging
=============
*/
void PrintOccluded( byte occluded[LIGHTMAP_WIDTH*EXTRASCALE][LIGHTMAP_HEIGHT*EXTRASCALE], 
				   int width, int height ) {
	int	i, j;

	_printf( "\n" );

	for ( i = 0 ; i < height ; i++ ) {
		for ( j = 0 ; j < width ; j++ ) {
			_printf("%i", (int)occluded[j][i] );
		}
		_printf( "\n" );
	}
}


/*
=============
VertexLighting

Vertex lighting will completely ignore occlusion, because
shadows would not be resolvable anyway.
=============
*/
void VertexLighting( dsurface_t *ds, qboolean testOcclusion, qboolean forceSunLight, float scale, traceWork_t *tw ) {
	int			i, j;
	drawVert_t	*dv;
	vec3_t		sample, normal;
	float		max;

	VectorCopy( ds->lightmapVecs[2], normal );

	// generate vertex lighting
	for ( i = 0 ; i < ds->numVerts ; i++ ) {
		dv = &drawVerts[ ds->firstVert + i ];

		if ( ds->patchWidth ) {
			LightingAtSample( dv->xyz, dv->normal, sample, testOcclusion, forceSunLight, tw );
		}
		else if (ds->surfaceType == MST_TRIANGLE_SOUP) {
			LightingAtSample( dv->xyz, dv->normal, sample, testOcclusion, forceSunLight, tw );
		}
		else {
			LightingAtSample( dv->xyz, normal, sample, testOcclusion, forceSunLight, tw );
		}

		if (scale >= 0)
			VectorScale(sample, scale, sample);
		// clamp with color normalization
		max = sample[0];
		if ( sample[1] > max ) {
			max = sample[1];
		}
		if ( sample[2] > max ) {
			max = sample[2];
		}
		if ( max > 255 ) {
			VectorScale( sample, 255/max, sample );
		}

		// save the sample
		for ( j = 0 ; j < 3 ; j++ ) {
			if ( sample[j] > 255 ) {
				sample[j] = 255;
			}
			dv->color[j] = sample[j];
		}

		// Don't bother writing alpha since it will already be set to 255,
		// plus we don't want to write over alpha generated by SetTerrainTextures
		//dv->color[3] = 255;
	}
}


/*
=================
LinearSubdivideMesh

For extra lighting, just midpoint one of the axis.
The edges are clamped at the original edges.
=================
*/
mesh_t *LinearSubdivideMesh( mesh_t *in ) {
	int			i, j;
	mesh_t		*out;
	drawVert_t	*v1, *v2, *vout;

	out = malloc( sizeof( *out ) );

	out->width = in->width * 2;
	out->height = in->height;
	out->verts = malloc( out->width * out->height * sizeof(*out->verts) );
	for ( j = 0 ; j < in->height ; j++ ) {
		out->verts[ j * out->width + 0 ] = in->verts[ j * in->width + 0 ];
		out->verts[ j * out->width + out->width - 1 ] = in->verts[ j * in->width + in->width - 1 ];
		for ( i = 1 ; i < out->width - 1 ; i+= 2 ) {
			v1 = in->verts + j * in->width + (i >> 1);
			v2 = v1 + 1;
			vout = out->verts + j * out->width + i;

			vout->xyz[0] = 0.75 * v1->xyz[0] + 0.25 * v2->xyz[0];
			vout->xyz[1] = 0.75 * v1->xyz[1] + 0.25 * v2->xyz[1];
			vout->xyz[2] = 0.75 * v1->xyz[2] + 0.25 * v2->xyz[2];

			vout->normal[0] = 0.75 * v1->normal[0] + 0.25 * v2->normal[0];
			vout->normal[1] = 0.75 * v1->normal[1] + 0.25 * v2->normal[1];
			vout->normal[2] = 0.75 * v1->normal[2] + 0.25 * v2->normal[2];

			VectorNormalize( vout->normal, vout->normal );

			vout++;

			vout->xyz[0] = 0.25 * v1->xyz[0] + 0.75 * v2->xyz[0];
			vout->xyz[1] = 0.25 * v1->xyz[1] + 0.75 * v2->xyz[1];
			vout->xyz[2] = 0.25 * v1->xyz[2] + 0.75 * v2->xyz[2];

			vout->normal[0] = 0.25 * v1->normal[0] + 0.75 * v2->normal[0];
			vout->normal[1] = 0.25 * v1->normal[1] + 0.75 * v2->normal[1];
			vout->normal[2] = 0.25 * v1->normal[2] + 0.75 * v2->normal[2];

			VectorNormalize( vout->normal, vout->normal );

		}
	}

	FreeMesh( in );

	return out;
}

/*
==============
ColorToBytes
==============
*/
/*
=============
LightmapToBytes

A lightmap texel: the game doubles lightmap bytes as it loads them (r_mapOverBrightBits 1)
and rescales by colour above 255, so EA's compiler stores them rescaled by colour at 127,
the brightest a texel can show. The light grid and vertex colours are kept to 255.
=============
*/
void LightmapToBytes( const float *color, byte *colorBytes ) {
	float	max = color[0];
	vec3_t	sample;

	if ( color[1] > max ) {
		max = color[1];
	}
	if ( color[2] > max ) {
		max = color[2];
	}
	VectorCopy( color, sample );
	if ( max > 127 ) {
		VectorScale( sample, 127 / max, sample );
	}
	colorBytes[0] = sample[0];
	colorBytes[1] = sample[1];
	colorBytes[2] = sample[2];
}

void ColorToBytes( const float *color, byte *colorBytes ) {
	float	max;
	vec3_t	sample;

	VectorCopy( color, sample );

	// clamp with color normalization
	max = sample[0];
	if ( sample[1] > max ) {
		max = sample[1];
	}
	if ( sample[2] > max ) {
		max = sample[2];
	}
	if ( max > 255 ) {
		VectorScale( sample, 255/max, sample );
	}
	colorBytes[ 0 ] = sample[0];
	colorBytes[ 1 ] = sample[1];
	colorBytes[ 2 ] = sample[2];
}



/*
=============
TraceLtm
=============
*/
void TraceLtm( int num ) {
	dsurface_t	*ds;
	int			i, j, k;
	int			x, y;
	int			position, numPositions;
	vec3_t		base, origin, normal;
	byte		occluded[LIGHTMAP_WIDTH*EXTRASCALE][LIGHTMAP_HEIGHT*EXTRASCALE];
	vec3_t		color[LIGHTMAP_WIDTH*EXTRASCALE][LIGHTMAP_HEIGHT*EXTRASCALE];
	traceWork_t	tw;
	vec3_t		average;
	int			count;
	mesh_t		srcMesh, *mesh, *subdivided;
	shaderInfo_t	*si;
	static float	nudge[2][9] = {
		{ 0, -1, 0, 1, -1, 1, -1, 0, 1 },
		{ 0, -1, -1, -1, 0, 0, 1, 1, 1 }
	};
	int			sampleWidth, sampleHeight, ssize;
	vec3_t		lightmapOrigin, lightmapVecs[2];
	int widthtable[LIGHTMAP_WIDTH], heighttable[LIGHTMAP_WIDTH];

	ds = &drawSurfaces[num];
	si = ShaderInfoForShader( dshaders[ ds->shaderNum].shader );

	// vertex-lit triangle model
	if ( ds->surfaceType == MST_TRIANGLE_SOUP ) {
		VertexLighting( ds, !si->noVertexShadows, si->forceSunLight, 1.0, &tw );
		return;
	}
	
	if ( ds->lightmapNum == -1 ) {
		return;		// doesn't need lighting at all
	}

	if (!novertexlighting) {
		// calculate the vertex lighting for gouraud shade mode
		VertexLighting( ds, si->vertexShadows, si->forceSunLight, si->vertexScale, &tw );
	}

	if ( ds->lightmapNum < 0 ) {
		return;		// doesn't need lightmap lighting
	}

	si = ShaderInfoForShader( dshaders[ ds->shaderNum].shader );
	ssize = samplesize;
	if (si->lightmapSampleSize)
		ssize = si->lightmapSampleSize;

	if (si->patchShadows)
		tw.patchshadows = qtrue;
	else
		tw.patchshadows = patchshadows;

	if ( ds->surfaceType == MST_PATCH ) {
		srcMesh.width = ds->patchWidth;
		srcMesh.height = ds->patchHeight;
		srcMesh.verts = drawVerts + ds->firstVert;
		mesh = SubdivideMesh( srcMesh, 8, 999 );
		PutMeshOnCurve( *mesh );
		MakeMeshNormals( *mesh );

		subdivided = RemoveLinearMeshColumnsRows( mesh );
		FreeMesh(mesh);

		mesh = SubdivideMeshQuads( subdivided, ssize, LIGHTMAP_WIDTH, widthtable, heighttable);
		if ( mesh->width != ds->lightmapWidth || mesh->height != ds->lightmapHeight ) {
			Error( "Mesh lightmap miscount");
		}

		if ( extra ) {
			mesh_t	*mp;

			// chop it up for more light samples (leaking memory...)
			mp = mesh;//CopyMesh( mesh );
			mp = LinearSubdivideMesh( mp );
			mp = TransposeMesh( mp );
			mp = LinearSubdivideMesh( mp );
			mp = TransposeMesh( mp );

			mesh = mp;
		}
	} else {
		VectorCopy( ds->lightmapVecs[2], normal );

		if ( !extra ) {
			VectorCopy( ds->lightmapOrigin, lightmapOrigin );
			VectorCopy( ds->lightmapVecs[0], lightmapVecs[0] );
			VectorCopy( ds->lightmapVecs[1], lightmapVecs[1] );
		} else {
			// sample at a closer spacing for antialiasing
			VectorCopy( ds->lightmapOrigin, lightmapOrigin );
			VectorScale( ds->lightmapVecs[0], 0.5, lightmapVecs[0] );
			VectorScale( ds->lightmapVecs[1], 0.5, lightmapVecs[1] );
			VectorMA( lightmapOrigin, -0.5, lightmapVecs[0], lightmapOrigin );
			VectorMA( lightmapOrigin, -0.5, lightmapVecs[1], lightmapOrigin );
		}
	}

	if ( extra ) {
		sampleWidth = ds->lightmapWidth * 2;
		sampleHeight = ds->lightmapHeight * 2;
	} else {
		sampleWidth = ds->lightmapWidth;
		sampleHeight = ds->lightmapHeight;
	}

	memset ( color, 0, sizeof( color ) );

	// determine which samples are occluded
	memset ( occluded, 0, sizeof( occluded ) );
	for ( i = 0 ; i < sampleWidth ; i++ ) {
		for ( j = 0 ; j < sampleHeight ; j++ ) {

			if ( ds->patchWidth ) {
				numPositions = 9;
				VectorCopy( mesh->verts[j*mesh->width+i].normal, normal );
				// VectorNormalize( normal, normal );
				// push off of the curve a bit
				VectorMA( mesh->verts[j*mesh->width+i].xyz, 1, normal, base );

				MakeNormalVectors( normal, lightmapVecs[0], lightmapVecs[1] );
			} else {
				numPositions = 9;
				for ( k = 0 ; k < 3 ; k++ ) {
					base[k] = lightmapOrigin[k] + normal[k]
						+ i * lightmapVecs[0][k] 
						+ j * lightmapVecs[1][k];
				}
			}
			VectorAdd( base, surfaceOrigin[ num ], base );

			// we may need to slightly nudge the sample point
			// if directly on a wall
			for ( position = 0 ; position < numPositions ; position++ ) {
				// calculate lightmap sample position
				for ( k = 0 ; k < 3 ; k++ ) {
					origin[k] = base[k] + 
						+ ( nudge[0][position]/16 ) * lightmapVecs[0][k] 
						+ ( nudge[1][position]/16 ) * lightmapVecs[1][k];
				}

				if ( notrace ) {
					break;
				}
				if ( !PointInSolid( origin ) ) {
					break;
				}
			}

			// if none of the nudges worked, this sample is occluded
			if ( position == numPositions ) {
				occluded[i][j] = qtrue;
				if ( numthreads == 1 ) {
					c_occluded++;
				}
				continue;
			}
			
			if ( numthreads == 1 ) {
				c_visible++;
			}
			occluded[i][j] = qfalse;
			LightingAtSample( origin, normal, color[i][j], qtrue, qfalse, &tw );
		}
	}

	if ( dump ) {
		PrintOccluded( occluded, sampleWidth, sampleHeight );
	}

	// calculate average values for occluded samples
	for ( i = 0 ; i < sampleWidth ; i++ ) {
		for ( j = 0 ; j < sampleHeight ; j++ ) {
			if ( !occluded[i][j] ) {
				continue;
			}
			// scan all surrounding samples
			count = 0;
			VectorClear( average );
			for ( x = -1 ; x <= 1; x++ ) {
				for ( y = -1 ; y <= 1 ; y++ ) {
					if ( i + x < 0 || i + x >= sampleWidth ) {
						continue;
					}
					if ( j + y < 0 || j + y >= sampleHeight ) {
						continue;
					}
					if ( occluded[i+x][j+y] ) {
						continue;
					}
					count++;
					VectorAdd( color[i+x][j+y], average, average );
				}
			}
			if ( count ) {
				VectorScale( average, 1.0/count, color[i][j] );
			}
		}
	}

	// average together the values if we are extra sampling
	if ( ds->lightmapWidth != sampleWidth ) {
		for ( i = 0 ; i < ds->lightmapWidth ; i++ ) {
			for ( j = 0 ; j < ds->lightmapHeight ; j++ ) {
				for ( k = 0 ; k < 3 ; k++ ) {
					float		value, coverage;

					value = color[i*2][j*2][k] + color[i*2][j*2+1][k] +
						color[i*2+1][j*2][k] + color[i*2+1][j*2+1][k];
					coverage = 4;
					if ( extraWide ) {
						// wider than box filter
						if ( i > 0 ) {
							value += color[i*2-1][j*2][k] + color[i*2-1][j*2+1][k];
							value += color[i*2-2][j*2][k] + color[i*2-2][j*2+1][k];
							coverage += 4;
						}
						if ( i < ds->lightmapWidth - 1 ) {
							value += color[i*2+2][j*2][k] + color[i*2+2][j*2+1][k];
							value += color[i*2+3][j*2][k] + color[i*2+3][j*2+1][k];
							coverage += 4;
						}
						if ( j > 0 ) {
							value += color[i*2][j*2-1][k] + color[i*2+1][j*2-1][k];
							value += color[i*2][j*2-2][k] + color[i*2+1][j*2-2][k];
							coverage += 4;
						}
						if ( j < ds->lightmapHeight - 1 ) {
							value += color[i*2][j*2+2][k] + color[i*2+1][j*2+2][k];
							value += color[i*2][j*2+3][k] + color[i*2+1][j*2+3][k];
							coverage += 2;
						}
					}

					color[i][j][k] = value / coverage;
				}
			}
		}
	}

	// optionally create a debugging border around the lightmap
	if ( lightmapBorder ) {
		for ( i = 0 ; i < ds->lightmapWidth ; i++ ) {
			color[i][0][0] = 255;
			color[i][0][1] = 0;
			color[i][0][2] = 0;

			color[i][ds->lightmapHeight-1][0] = 255;
			color[i][ds->lightmapHeight-1][1] = 0;
			color[i][ds->lightmapHeight-1][2] = 0;
		}
		for ( i = 0 ; i < ds->lightmapHeight ; i++ ) {
			color[0][i][0] = 255;
			color[0][i][1] = 0;
			color[0][i][2] = 0;

			color[ds->lightmapWidth-1][i][0] = 255;
			color[ds->lightmapWidth-1][i][1] = 0;
			color[ds->lightmapWidth-1][i][2] = 0;
		}
	}

	// clamp the colors to bytes and store off
	for ( i = 0 ; i < ds->lightmapWidth ; i++ ) {
		for ( j = 0 ; j < ds->lightmapHeight ; j++ ) {
			k = ( ds->lightmapNum * LIGHTMAP_HEIGHT + ds->lightmapY + j) 
				* LIGHTMAP_WIDTH + ds->lightmapX + i;

			LightmapToBytes( color[i][j], lightBytes + k*3 );
		}
	}

	if (ds->surfaceType == MST_PATCH)
	{
		FreeMesh(mesh);
	}
}


//=============================================================================

vec3_t	gridMins;
vec3_t	gridSize = { 32, 32, 32 };	// the game reads a version 19 .bsp's grid at 32 units
int		gridBounds[3];


/*
========================
LightContributionToPoint
========================
*/
qboolean LightContributionToPoint( const light_t *light, const vec3_t origin,
								  vec3_t color, traceWork_t *tw ) {
	trace_t		trace;
	float		add;

	add = 0;

	VectorClear( color );

	// testing exact PTPFF
	if ( exactPointToPolygon && light->type == emit_area ) {
		float		factor;
		float		d;
		vec3_t		normal;

		// see if the point is behind the light
		d = DotProduct( origin, light->normal ) - light->dist;
		if ( !light->twosided ) {
			if ( d < 1 ) {
				return qfalse;		// point is behind light
			}
		}

		// test occlusion
		// clip the line, tracing from the surface towards the light
		TraceLine( origin, light->origin, &trace, qfalse, tw );
		if ( trace.passSolid ) {
			return qfalse;
		}

		// calculate the contribution
		VectorSubtract( light->origin, origin, normal );
		if ( VectorNormalize( normal, normal ) == 0 ) {
			return qfalse;
		}
		factor = PointToPolygonFormFactor( origin, normal, light->w );
		if ( factor <= 0 ) {
			if ( light->twosided ) {
				factor = -factor;
			} else {
				return qfalse;
			}
		}
		VectorScale( light->emitColor, factor, color );
		return qtrue;
	}

	// calculate the amount of light at this sample
	if ( light->type == emit_point || light->type == emit_spotlight ) {
		vec3_t		dir;
		float		dist;

		VectorSubtract( light->origin, origin, dir );
		dist = VectorLength( dir );
		// clamp the distance to prevent super hot spots
		if ( dist < 16 ) {
			dist = 16;
		}
		if ( light->linearLight ) {
			add = light->photons * linearScale - dist;
			if ( add < 0 ) {
				add = 0;
			}
		} else {
			add = light->photons / ( dist * dist );
		}
	} else {
		return qfalse;
	}

	if ( add <= 1.0 ) {
		return qfalse;
	}

	// clip the line, tracing from the surface towards the light
	TraceLine( origin, light->origin, &trace, qfalse, tw );

	// other light rays must not hit anything
	if ( trace.passSolid ) {
		return qfalse;
	}

	// add the result
	color[0] = add * light->color[0];
	color[1] = add * light->color[1];
	color[2] = add * light->color[2];

	return qtrue;
}

typedef struct {
	vec3_t		dir;
	vec3_t		color;
} contribution_t;

/*
=============
TraceGrid

Grid samples are foe quickly determining the lighting
of dynamically placed entities in the world
=============
*/
#define	MAX_CONTRIBUTIONS	1024
void TraceGrid( int num ) {
	int			x, y, z;
	vec3_t		origin;
	light_t		*light;
	vec3_t		color;
	int			mod;
	vec3_t		directedColor;
	vec3_t		summedDir;
	contribution_t	contributions[MAX_CONTRIBUTIONS];
	int			numCon;
	int			i;
	traceWork_t	tw;
	float		addSize;

	tw.patchshadows = qtrue;		// curved patches shade the grid, as the game's grids show (m4l0)
	mod = num;
	z = mod / ( gridBounds[0] * gridBounds[1] );
	mod -= z * ( gridBounds[0] * gridBounds[1] );

	y = mod / gridBounds[0];
	mod -= y * gridBounds[0];

	x = mod;

	origin[0] = gridMins[0] + x * gridSize[0];
	origin[1] = gridMins[1] + y * gridSize[1];
	origin[2] = gridMins[2] + z * gridSize[2];

	if ( PointInSolid( origin ) ) {
		vec3_t	baseOrigin;
		int		step;

		VectorCopy( origin, baseOrigin );

		// try to nudge the origin around to find a valid point
		for ( step = 9 ; step <= 18 ; step += 9 ) {
			for ( i = 0 ; i < 8 ; i++ ) {
				VectorCopy( baseOrigin, origin );
				if ( i & 1 ) {
					origin[0] += step;
				} else {
					origin[0] -= step;
				}
				if ( i & 2 ) {
					origin[1] += step;
				} else {
					origin[1] -= step;
				}
				if ( i & 4 ) {
					origin[2] += step;
				} else {
					origin[2] -= step;
				}

				if ( !PointInSolid( origin ) ) {
					break;
				}
			}
			if ( i != 8 ) {
				break;
			}
		}
		if ( step > 18 ) {
			// can't find a valid point at all
			for ( i = 0 ; i < 8 ; i++ ) {
				gridData[ num*8 + i ] = 0;
			}
			return;
		}
	}

	VectorClear( summedDir );

	// trace to all the lights

	// find the major light direction, and divide the
	// total light between that along the direction and
	// the remaining in the ambient 
	numCon = 0;
	for ( light = lights ; light ; light = light->next ) {
		vec3_t		add;
		vec3_t		dir;
		float		addSize;

		if ( !LightContributionToPoint( light, origin, add, &tw ) ) {
			continue;
		}

		VectorSubtract( light->origin, origin, dir );
		VectorNormalize( dir, dir );

		VectorCopy( add, contributions[numCon].color );
		VectorCopy( dir, contributions[numCon].dir );
		numCon++;

		addSize = VectorLength( add );
		VectorMA( summedDir, addSize, dir, summedDir );

		if ( numCon == MAX_CONTRIBUTIONS-1 ) {
			break;
		}
	}

	//
	// trace directly to the sun
	//
	SunToPoint( origin, &tw, color );
	addSize = VectorLength( color );
	if ( addSize > 0 ) {
		VectorCopy( color, contributions[numCon].color );
		VectorCopy( sunDirection, contributions[numCon].dir );
		VectorMA( summedDir, addSize, sunDirection, summedDir );
		numCon++;
	}


	// now that we have identified the primary light direction,
	// go back and seperate all the light into directed and ambient
	VectorNormalize( summedDir, summedDir );
	VectorCopy( ambientColor, color );
	VectorClear( directedColor );

	for ( i = 0 ; i < numCon ; i++ ) {
		float	d;

		d = DotProduct( contributions[i].dir, summedDir );
		if ( d < 0 ) {
			d = 0;
		}

		VectorMA( directedColor, d, contributions[i].color, directedColor );

		// the ambient light will be at 1/4 the value of directed light
		d = 0.25 * ( 1.0 - d );
		VectorMA( color, d, contributions[i].color, color );
	}

	// now do some fudging to keep the ambient from being too low
	VectorMA( color, 0.25, directedColor, color );

	//
	// MoHAA keeps one colour per point: the ambient light and everything that reaches
	// it, added (bytes 0-2); byte 7 marks a point that isn't in solid
	//
	VectorCopy( ambientColor, color );
	for ( i = 0 ; i < numCon ; i++ ) {
		VectorAdd( color, contributions[i].color, color );
	}
	{
		// the sky's light at a grid point that sees any sky: 0.74 of the sky colour, as
		// the game's own grids have it (mohdm6: ambient 20 + sun 85 + 63 in the open,
		// 20 + 63 in the shade; m4l0 the same with its own colours)
		vec3_t	sky;
		VectorClear( sky );
		SkyDiffuseToPoint( origin, NULL, &tw, sky );
		if ( sky[0] > 0 || sky[1] > 0 || sky[2] > 0 ) {
			VectorMA( color, 0.74f * skyDiffuse, skyDiffuseColor, color );
		}
	}
	ColorToBytes( color, gridData + num*8 );
	gridData[ num*8 + 3 ] = gridData[ num*8 + 4 ] = gridData[ num*8 + 5 ] = gridData[ num*8 + 6 ] = 0;
	gridData[ num*8 + 7 ] = 1;
}


/*
=============
MohVertexLight

A static model's vertex light, the way the game lights a model from its sphere lights
(renderergl1/tr_sphere_shade.cpp): each light's strength is taken at the model's centre
(intensity * 7500 / distance^2, and none under 1), and each vertex takes it by how far it
faces the light, v.n / |v|^2 with v the way from the vertex to the light, times the
distance from the centre; the sun by the vertex's facing alone; and a light everywhere on
the model made of the world's ambient light and the light grid at its centre. A light
deep inside a lamp still lights the lamp's outside this way, as in the game's maps.
The scales are the ones the game's maps fit: lights 2, the sun and the ambient light 2.6
(the game's sun and ambient are doubled for overbright and scaled by r_entlight_scale
1.3), the grid 0.234 (the game's 0.18 times 1.3).
=============
*/
#define PROP_LIGHT_SCALE	2.0f
#define PROP_SUN_SCALE		2.6f
#define PROP_AMBIENT_SCALE	2.6f
#define PROP_GRID_SCALE		0.234f
#define PROP_MIN_DIST		8.0f

// a point clear of the world's solid, from origin toward dir (normalized), within 16 units;
// origin itself when none is
static void MohClearStart( const vec3_t origin, const vec3_t dir, vec3_t out ) {
	int		i;

	VectorCopy( origin, out );
	for ( i = 1 ; i <= 8 ; i++ ) {
		vec3_t	p;
		VectorMA( origin, i * 2.0f, dir, p );
		if ( !PointInSolid( p ) ) {
			VectorCopy( p, out );
			return;
		}
	}
}

/*
MohGridLight: the light grid's colour at a point, from the eight grid points round it as
the game reads it (R_GetLightingGridValue), leaving out points in solid. Black when the
grid wasn't lit.
*/
void MohGridLight( const vec3_t point, vec3_t color ) {
	int		pos[3], i, j;
	float	frac[3], total = 0;

	VectorClear( color );
	if ( nogridlighting || gridBounds[0] < 2 || gridBounds[1] < 2 || gridBounds[2] < 2 ) {
		return;
	}
	for ( i = 0 ; i < 3 ; i++ ) {
		float v = ( point[i] - gridMins[i] ) / gridSize[i];
		pos[i] = (int)floor( v );
		frac[i] = v - pos[i];
		if ( pos[i] < 0 ) {
			pos[i] = 0;
			frac[i] = 0;
		} else if ( pos[i] > gridBounds[i] - 2 ) {
			pos[i] = gridBounds[i] - 2;
			frac[i] = 1;
		}
	}
	for ( i = 0 ; i < 8 ; i++ ) {
		float	w = 1;
		int		num;
		byte	*g;

		for ( j = 0 ; j < 3 ; j++ ) {
			w *= ( i & ( 1 << j ) ) ? frac[j] : 1 - frac[j];
		}
		num = ( pos[0] + ( i & 1 ) ) + ( pos[1] + ( ( i >> 1 ) & 1 ) ) * gridBounds[0]
			+ ( pos[2] + ( ( i >> 2 ) & 1 ) ) * gridBounds[0] * gridBounds[1];
		g = gridData + num * 8;
		if ( !g[7] || w <= 0 ) {
			continue;
		}
		color[0] += w * g[0];
		color[1] += w * g[1];
		color[2] += w * g[2];
		total += w;
	}
	if ( total > 0 ) {
		VectorScale( color, 1.0f / total, color );
	}
}

/*
The light on the whole of a static model: the ambient light and the grid at its centre.
*/
void MohStaticModelBase( const vec3_t centre, vec3_t base ) {
	vec3_t	grid;

	MohGridLight( centre, grid );
	VectorScale( ambientColor, PROP_AMBIENT_SCALE, base );
	VectorMA( base, PROP_GRID_SCALE, grid, base );
}

/*
A static model's vertex (vertex, its normal; point, the vertex a little off the model,
where the light is traced from). A model often reaches into the brushes it stands on or
hangs from (a lamp's bulb in the ceiling, a crate's foot in the floor); the game's maps
light such a vertex as if the brush weren't there when it is no more than 16 units in
(deeper, it stays dark), so its light is tested from the first clear point on the way to
the light.
*/
void MohVertexLight( const vec3_t point, const vec3_t vertex, const vec3_t normal, const vec3_t centre,
					 const vec3_t base, vec3_t color, traceWork_t *tw ) {
	vec3_t		add, dir, start, v, here;
	light_t		*light;
	trace_t		trace;
	float		d, dist, centreDist, facing;
	qboolean	buried;

	VectorCopy( base, color );
	VectorCopy( point, here );
	buried = PointInSolid( here );
	for ( light = lights ; light ; light = light->next ) {
		if ( light->type != emit_point && light->type != emit_spotlight ) {
			continue;
		}
		if ( light->type == emit_spotlight ) {
			// inside the cone only, as LightingAtSample has it
			float	distByNormal, radiusAtDist, sampleRadius;
			vec3_t	pointAtDist, distToSample;

			VectorSubtract( point, light->origin, dir );
			distByNormal = DotProduct( dir, light->normal );
			if ( distByNormal < 0 ) {
				continue;
			}
			VectorMA( light->origin, distByNormal, light->normal, pointAtDist );
			radiusAtDist = light->radiusByDist * distByNormal;
			VectorSubtract( point, pointAtDist, distToSample );
			sampleRadius = VectorLength( distToSample );
			if ( sampleRadius >= radiusAtDist ) {
				continue;
			}
		}

		// the light's strength at the model's centre
		VectorSubtract( light->origin, centre, dir );
		centreDist = VectorLength( dir );
		if ( centreDist < PROP_MIN_DIST ) {
			centreDist = PROP_MIN_DIST;
		}
		if ( light->linearLight ) {
			d = light->photons * linearScale - centreDist;
		} else {
			d = light->photons / ( centreDist * centreDist );
		}
		if ( d <= 1.0f ) {
			continue;
		}

		// the vertex's facing
		VectorSubtract( light->origin, vertex, v );
		dist = VectorLength( v );
		if ( dist < PROP_MIN_DIST ) {
			dist = PROP_MIN_DIST;
		}
		facing = DotProduct( v, normal ) / ( dist * dist );
		if ( facing <= 0 ) {
			continue;
		}

		VectorSubtract( light->origin, point, dir );
		VectorNormalize( dir, dir );
		VectorCopy( point, start );
		if ( buried ) {
			MohClearStart( point, dir, start );
		}
		TraceLine( start, light->origin, &trace, qfalse, tw );
		if ( trace.passSolid ) {
			continue;
		}
		VectorScale( light->color, PROP_LIGHT_SCALE * d * centreDist * facing, add );
		VectorAdd( color, add, color );
	}

	d = DotProduct( sunDirection, normal );
	if ( d > 0 ) {
		VectorCopy( point, start );
		if ( buried ) {
			MohClearStart( point, sunDirection, start );
		}
		SunToPoint( start, tw, add );
		VectorMA( color, PROP_SUN_SCALE * d, add, color );
	}
}

/*
=============
SetupGrid
=============
*/
void SetupGrid( void ) {
	int		i;
	vec3_t	maxs;

	for ( i = 0 ; i < 3 ; i++ ) {
		gridMins[i] = gridSize[i] * ceil( dmodels[0].mins[i] / gridSize[i] );
		maxs[i] = gridSize[i] * floor( dmodels[0].maxs[i] / gridSize[i] );
		gridBounds[i] = (maxs[i] - gridMins[i])/gridSize[i] + 1;
	}

	numGridPoints = gridBounds[0] * gridBounds[1] * gridBounds[2];
	if (numGridPoints * 8 >= MAX_MAP_LIGHTGRID)
		Error("MAX_MAP_LIGHTGRID");
	qprintf( "%5i gridPoints\n", numGridPoints );
}

//=============================================================================

/*
=============
RemoveLightsInSolid
=============
*/
void RemoveLightsInSolid(void)
{
	light_t *light, *prev;
	int numsolid = 0;

	prev = NULL;
	for ( light = lights ; light ;  ) {
		if (PointInSolid(light->origin))
		{
			if (prev) prev->next = light->next;
			else lights = light->next;
			if (light->w)
				FreeWinding(light->w);
			free(light);
			numsolid++;
			if (prev)
				light = prev->next;
			else
				light = lights;
		}
		else
		{
			prev = light;
			light = light->next;
		}
	}
	_printf (" %7i lights in solid\n", numsolid);
}

/*
=============
LightWorld
=============
*/
void LightWorld (void) {
	float		f;

	// determine the number of grid points
	SetupGrid();

	// find the optional world ambient
	GetVectorForKey( &entities[0], "_color", ambientColor );
	f = FloatForKey( &entities[0], "ambient" );
	VectorScale( ambientColor, f, ambientColor );
	MohWorldLight();
	// -sunscale / -skyscale: the sun's and the sky's light baked here, not the keys the game
	// reads (the game's own sun for models keeps "suncolor")
	if ( sunScale != 1 ) {
		VectorScale( sunLight, sunScale, sunLight );
		_printf( "sun light scaled by %g\n", sunScale );
	}
	if ( skyScale != 1 ) {
		skyDiffuse *= skyScale;
		_printf( "sky light (sundiffuse) scaled by %g\n", skyScale );
	}

	// create lights out of patches and lights
	qprintf ("--- CreateLights ---\n");
	CreateEntityLights ();
	qprintf ("%i point lights\n", numPointLights);
	qprintf ("%i area lights\n", numAreaLights);

	if (!nogridlighting) {
		qprintf ("--- TraceGrid ---\n");
		RunThreadsOnIndividual( numGridPoints, qtrue, TraceGrid );
		qprintf( "%i x %i x %i = %i grid\n", gridBounds[0], gridBounds[1],
			gridBounds[2], numGridPoints);
		MohEncodeLightGrid();
	}

	qprintf ("--- TraceLtm ---\n");
	RunThreadsOnIndividual( numDrawSurfaces, qtrue, TraceLtm );
	TerrainLightmaps();

	MohSphereLights();
	MohStaticModelLight();
	qprintf( "%5i visible samples\n", c_visible );
	qprintf( "%5i occluded samples\n", c_occluded );
}

/*
========
CreateFilters

EXPERIMENTAL, UNUSED

Look for transparent light filter surfaces.

This will only work for flat 3*3 patches that exactly hold one copy of the texture.
========
*/
#define	PLANAR_PATCH_EPSILON	0.1
void CreateFilters( void ) {
	int				i;
	filter_t		*f;
	dsurface_t		*ds;
	shaderInfo_t	*si;
	drawVert_t		*v1, *v2, *v3;
	vec3_t			d1, d2;
	int				vertNum;

	numFilters = 0;

	return;

	for ( i = 0 ; i < numDrawSurfaces ; i++ ) {
		ds = &drawSurfaces[i];
		if ( !ds->patchWidth ) {
			continue;
		}
		si = ShaderInfoForShader( dshaders[ ds->shaderNum ].shader );
/*
		if ( !(si->surfaceFlags & SURF_LIGHTFILTER) ) {
			continue;
		}
*/

		// we have a filter patch
		v1 = &drawVerts[ ds->firstVert ];

		if ( ds->patchWidth != 3 || ds->patchHeight != 3 ) {
			_printf("WARNING: patch at %i %i %i has SURF_LIGHTFILTER but isn't a 3 by 3\n",
				v1->xyz[0], v1->xyz[1], v1->xyz[2] );
			continue;
		}

		if ( numFilters == MAX_FILTERS ) {
			Error( "MAX_FILTERS" );
		}
		f = &filters[ numFilters ];
		numFilters++;

		v2 = &drawVerts[ ds->firstVert + 2 ];
		v3 = &drawVerts[ ds->firstVert + 6 ];

		VectorSubtract( v2->xyz, v1->xyz, d1 );
		VectorSubtract( v3->xyz, v1->xyz, d2 );
		VectorNormalize( d1, d1 );
		VectorNormalize( d2, d2 );
		CrossProduct( d1, d2, f->plane );
		f->plane[3] = DotProduct( v1->xyz, f->plane );

		// make sure all the control points are on the plane
		for ( vertNum = 0 ; vertNum < ds->numVerts ; vertNum++ ) {
			float	d;

			d = DotProduct( drawVerts[ ds->firstVert + vertNum ].xyz, f->plane ) - f->plane[3];
			if ( fabs( d ) > PLANAR_PATCH_EPSILON ) {
				break;
			}
		}
		if ( vertNum != ds->numVerts ) {
			numFilters--;
			_printf("WARNING: patch at %i %i %i has SURF_LIGHTFILTER but isn't flat\n",
				v1->xyz[0], v1->xyz[1], v1->xyz[2] );
			continue;
		}
	}

	f = &filters[0];
	numFilters = 1;

	f->plane[0] = 1;
	f->plane[1] = 0;
	f->plane[2] = 0;
	f->plane[3] = 448;

	f->origin[0] = 448;
	f->origin[1] = 192;
	f->origin[2] = 0;

	f->vectors[0][0] = 0;
	f->vectors[0][1] = -1.0 / 128;
	f->vectors[0][2] = 0;

	f->vectors[1][0] = 0;
	f->vectors[1][1] = 0;
	f->vectors[1][2] = 1.0 / 128;

	f->si = ShaderInfoForShader( "textures/hell/blocks11ct" );
}

/*
=============
VertexLightingThread
=============
*/
void VertexLightingThread(int num) {
	dsurface_t	*ds;
	traceWork_t	tw;
	shaderInfo_t *si;

	tw.patchshadows = patchshadows;
	ds = &drawSurfaces[num];

	// vertex-lit triangle model
	if ( ds->surfaceType == MST_TRIANGLE_SOUP ) {
		return;
	}

	if (novertexlighting)
		return;

	if ( ds->lightmapNum == -1 ) {
		return;	// doesn't need lighting at all
	}

	si = ShaderInfoForShader( dshaders[ ds->shaderNum].shader );

	// calculate the vertex lighting for gouraud shade mode
	VertexLighting( ds, si->vertexShadows, si->forceSunLight, si->vertexScale, &tw );
}

/*
=============
TriSoupLightingThread
=============
*/
void TriSoupLightingThread(int num) {
	dsurface_t	*ds;
	traceWork_t	tw;
	shaderInfo_t *si;

	tw.patchshadows = patchshadows;
	ds = &drawSurfaces[num];
	si = ShaderInfoForShader( dshaders[ ds->shaderNum].shader );

	// vertex-lit triangle model
	if ( ds->surfaceType == MST_TRIANGLE_SOUP ) {
		VertexLighting( ds, !si->noVertexShadows, si->forceSunLight, 1.0, &tw );
	}
}

/*
=============
GridAndVertexLighting
=============
*/
void GridAndVertexLighting(void) {
	SetupGrid();

	FindSkyBrushes();
	CreateFilters();
	InitTrace();
	CreateEntityLights ();
	CreateSurfaceLights();

	if (!nogridlighting) {
		_printf ("--- TraceGrid ---\n");
		RunThreadsOnIndividual( numGridPoints, qtrue, TraceGrid );
	}

	if (!novertexlighting) {
		_printf ("--- Vertex Lighting ---\n");
		RunThreadsOnIndividual( numDrawSurfaces, qtrue, VertexLightingThread );
	}

	_printf("--- Model Lighting ---\n");
	RunThreadsOnIndividual( numDrawSurfaces, qtrue, TriSoupLightingThread );
}

/*
========
LightMain

========
*/
int LightMain (int argc, char **argv) {
	int			i;
	double		start, end;
	const char	*value;

	_printf ("----- Lighting ----\n");

	verbose = qfalse;

	for (i=1 ; i<argc ; i++) {
		if (!strcmp(argv[i],"-tempname"))
    {
      i++;
    } else if (!strcmp(argv[i],"-v")) {
			verbose = qtrue;
		} else if (!strcmp(argv[i],"-threads")) {
			numthreads = atoi (argv[i+1]);
			i++;
		} else if (!strcmp(argv[i],"-area")) {
			areaScale *= atof(argv[i+1]);
			_printf ("area light scaling at %f\n", areaScale);
			i++;
		} else if (!strcmp(argv[i],"-nodiffusesun")) {
			noDiffuseSun = qtrue;
			_printf ("no diffuse sun (sky) light\n");
		} else if (!strcmp(argv[i],"-sunscale") && i + 1 < argc) {
			sunScale = atof(argv[i+1]);
			i++;
		} else if (!strcmp(argv[i],"-skyscale") && i + 1 < argc) {
			skyScale = atof(argv[i+1]);
			i++;
		} else if (!strcmp(argv[i],"-point")) {
			pointScale *= atof(argv[i+1]);
			_printf ("point light scaling at %f\n", pointScale);
			i++;
		} else if (!strcmp(argv[i],"-notrace")) {
			notrace = qtrue;
			_printf ("No occlusion tracing\n");
		} else if (!strcmp(argv[i],"-patchshadows")) {
			patchshadows = qtrue;
			_printf ("Patch shadow casting enabled\n");
		} else if (!strcmp(argv[i],"-extra")) {
			extra = qtrue;
			_printf ("Extra detail tracing\n");
		} else if (!strcmp(argv[i],"-extrawide")) {
			extra = qtrue;
			extraWide = qtrue;
			_printf ("Extra wide detail tracing\n");
		} else if (!strcmp(argv[i], "-samplesize")) {
			samplesize = atoi(argv[i+1]);
			if (samplesize < 1) samplesize = 1;
			i++;
			_printf("lightmap sample size is %dx%d units\n", samplesize, samplesize);
		} else if (!strcmp(argv[i], "-novertex")) {
			novertexlighting = qtrue;
			_printf("no vertex lighting = true\n");
		} else if (!strcmp(argv[i], "-nogrid")) {
			nogridlighting = qtrue;
			_printf("no grid lighting = true\n");
		} else if (!strcmp(argv[i],"-border")) {
			lightmapBorder = qtrue;
			_printf ("Adding debug border to lightmaps\n");
		} else if (!strcmp(argv[i],"-nosurf")) {
			noSurfaces = qtrue;
			_printf ("Not tracing against surfaces\n" );
		} else if (!strcmp(argv[i],"-dump")) {
			dump = qtrue;
			_printf ("Dumping occlusion maps\n");
		} else {
			break;
		}
	}

	ThreadSetDefault ();

	if (i != argc - 1) {
		_printf("usage: q3map -light [-<switch> [-<switch> ...]] <mapname>\n"
				"\n"
				"Switches:\n"
				"   v              = verbose output\n"
				"   threads <X>    = set number of threads to X\n"
				"   area <V>       = set the area light scale to V\n"
				"   point <W>      = set the point light scale to W\n"
				"   notrace        = don't cast any shadows\n"
				"   extra          = enable super sampling for anti-aliasing\n"
				"   extrawide      = same as extra but smoothen more\n"
				"   nogrid         = don't calculate light grid for dynamic model lighting\n"
				"   novertex       = don't calculate vertex lighting\n"
				"   samplesize <N> = set the lightmap pixel size to NxN units\n");
		exit(0);
	}

	start = I_FloatTime ();

	SetQdirFromPath (argv[i]);	

#if defined(_WIN32) && defined(OMMAP_PAK)
	InitPakFile(gamedir, NULL);
#endif

	strcpy (source, ExpandArg(argv[i]));
	StripExtension (source);
	DefaultExtension (source, ".bsp");

	LoadShaderInfo();

	_printf ("reading %s\n", source);

	LoadBSPFile (source);

	FindSkyBrushes();

	ParseEntities();

	value = ValueForKey( &entities[0], "gridsize" );
	if (strlen(value)) {
		sscanf( value, "%f %f %f", &gridSize[0], &gridSize[1], &gridSize[2] );
		_printf("grid size = {%1.1f, %1.1f, %1.1f}\n", gridSize[0], gridSize[1], gridSize[2]);
	}

	CreateFilters();

	InitTrace();

	SetEntityOrigins();

	CountLightmaps();

	CreateSurfaceLights();

	LightWorld();

	_printf ("writing %s\n", source);
	WriteBSPFile (source);

	end = I_FloatTime ();
	_printf ("%5.0f seconds elapsed\n", end-start);
	
	return 0;
}

