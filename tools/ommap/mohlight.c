/*
===========================================================================
MoHAA's lighting additions to the light step: the worldspawn's own light keys
(ambientlight, suncolor, sundirection) and the light grid in MoHAA's form.

This file is part of ommap, under the GNU General Public License, version 2 or later
(see the other files' headers).
===========================================================================
*/

#include "light.h"

extern char	source[1024];

extern vec3_t	ambientColor;
extern vec3_t	sunDirection;
extern vec3_t	sunLight;
extern vec3_t	gridMins;
extern vec3_t	gridSize;
extern int		gridBounds[3];


/*
================
MohWorldLight

MOHRadiant's worldspawn keys: "ambientlight" r g b (0-255, the light everywhere), and
the sun as "suncolor" r g b (0-255) from "sundirection" pitch yaw roll (the way to the
sun, so -90 is straight up). They take the place of the sky shader's q3map_sun and of
q3map's "_color" * "ambient".
================
*/
// EA's MOHlight reads a worldspawn light key only when its value is longer than one
// character (MOHlight.exe 0x42a29c..0x42a5c8: each key's strlen > 1): "sundiffuse" "3"
// is ignored and the default 1 is used, while "3.0" is read. The game's maps rely on it
// (m3l1b's "3" lights as 1), so the same rule is kept here.
static const char *EaKey( const char *key ) {
	const char *v = ValueForKey( &entities[0], key );
	return strlen( v ) > 1 ? v : "";
}

qboolean MohWorldLight( void ) {
	const char	*v;
	vec3_t		angles;
	qboolean	found = qfalse;

	v = EaKey( "ambientlight" );
	if ( v[0] ) {
		VectorClear( ambientColor );
		sscanf( v, "%f %f %f", &ambientColor[0], &ambientColor[1], &ambientColor[2] );
		found = qtrue;
	}
	v = EaKey( "suncolor" );
	if ( v[0] ) {
		VectorClear( sunLight );
		sscanf( v, "%f %f %f", &sunLight[0], &sunLight[1], &sunLight[2] );
		found = qtrue;
	}
	// "sunlight", read after "suncolor", replaces the sun's colour (EA's light step reads it
	// into the same place: mohdm1's "sunlight" "255 243 171" is its sun, not "suncolor")
	v = EaKey( "sunlight" );
	if ( v[0] ) {
		VectorClear( sunLight );
		sscanf( v, "%f %f %f", &sunLight[0], &sunLight[1], &sunLight[2] );
		found = qtrue;
	}
	// the sky's own light: "sundiffusecolor" times "sundiffuse" (default 1); without
	// "sundiffusecolor", the sun's colour
	v = EaKey( "sundiffusecolor" );
	if ( v[0] ) {
		VectorClear( skyDiffuseColor );
		sscanf( v, "%f %f %f", &skyDiffuseColor[0], &skyDiffuseColor[1], &skyDiffuseColor[2] );
	} else {
		VectorCopy( sunLight, skyDiffuseColor );
	}
	skyDiffuse = EaKey( "sundiffuse" )[0] ? atof( EaKey( "sundiffuse" ) ) : 1.0f;
	if ( noDiffuseSun ) {
		skyDiffuse = -1;			// -nodiffusesun, as EA's
	}
	// no sky light (sundiffuse 0 or less): EA's sun is 1.3 times as bright instead
	if ( skyDiffuse <= 0 ) {
		VectorScale( sunLight, 1.3f, sunLight );
	}
	v = ValueForKey( &entities[0], "sundirection" );
	if ( v[0] ) {
		VectorClear( angles );
		sscanf( v, "%f %f %f", &angles[0], &angles[1], &angles[2] );
		{
			// pitch and yaw to a direction, as the game turns angles into a forward vector
			double p = angles[0] * Q_PI / 180.0, y = angles[1] * Q_PI / 180.0;
			sunDirection[0] = cos( p ) * cos( y );
			sunDirection[1] = cos( p ) * sin( y );
			sunDirection[2] = -sin( p );
		}
	}
	if ( found ) {
		_printf( "MoHAA light: ambient %.0f %.0f %.0f, sun %.0f %.0f %.0f toward %.2f %.2f %.2f\n",
			ambientColor[0], ambientColor[1], ambientColor[2], sunLight[0], sunLight[1], sunLight[2],
			sunDirection[0], sunDirection[1], sunDirection[2] );
	}
	return found;
}

/*
================
The light grid

q3map's TraceGrid leaves 8 bytes per point in gridData (ambient rgb, directed rgb, the
direction); a point it couldn't place outside solid is all zeros. MoHAA keeps one colour
per point, as an index into a 256-colour palette (0: no light there), in columns along z
for each x and y, each column run-length coded:

	a byte c >= 0:	c + 2 points of the colour index that follows
	a byte c < 0:	-c points, each with its own index following

and offsets to the columns: Bx high parts (each times 256) for the x slices, then
Bx * By low parts, column (x, y) at [Bx + y + By * x]. This is how the game's renderer
reads it (renderergl1/tr_light.c, R_GetLightingGridValue).
================
*/

typedef struct {
	int		rgb[3];
	int		count;
} gridColor_t;

static int GridPointColor( int num, int *rgb ) {
	byte	*g = gridData + num * 8;
	int		k, v;

	if ( !g[7] ) {
		return 0;		// in solid
	}
	for ( k = 0 ; k < 3 ; k++ ) {
		rgb[k] = g[k];
	}
	return 1;
}

#define GRID_HASH	65536

void MohEncodeLightGrid( void ) {
	int			total, num, i, k, it, best, x, y, z, n, run;
	int			*index;
	gridColor_t	*colors;
	int			numColors, maxColors;
	int			*hashHead, *hashNext;
	float		cent[255][3];
	double		sum[255][4];
	int			numCent;
	byte		*column;
	int			cap;

	total = gridBounds[0] * gridBounds[1] * gridBounds[2];
	index = malloc( total * sizeof( int ) );
	maxColors = 65536;
	colors = malloc( maxColors * sizeof( gridColor_t ) );
	hashHead = malloc( GRID_HASH * sizeof( int ) );
	hashNext = malloc( maxColors * sizeof( int ) );
	for ( i = 0 ; i < GRID_HASH ; i++ ) {
		hashHead[i] = -1;
	}
	numColors = 0;

	// the distinct colours and how often each comes
	for ( num = 0 ; num < total ; num++ ) {
		int rgb[3], h;

		if ( !GridPointColor( num, rgb ) ) {
			index[num] = -1;
			continue;
		}
		h = ( rgb[0] * 31 + rgb[1] * 131 + rgb[2] * 1031 ) & ( GRID_HASH - 1 );
		for ( i = hashHead[h] ; i >= 0 ; i = hashNext[i] ) {
			if ( colors[i].rgb[0] == rgb[0] && colors[i].rgb[1] == rgb[1] && colors[i].rgb[2] == rgb[2] ) {
				break;
			}
		}
		if ( i < 0 ) {
			if ( numColors == maxColors ) {
				maxColors *= 2;
				colors = realloc( colors, maxColors * sizeof( gridColor_t ) );
				hashNext = realloc( hashNext, maxColors * sizeof( int ) );
			}
			i = numColors++;
			VectorCopy( rgb, colors[i].rgb );
			colors[i].count = 0;
			hashNext[i] = hashHead[h];
			hashHead[h] = i;
		}
		colors[i].count++;
		index[num] = i;
	}

	// 255 palette colours (index 0 is "no light here"): the distinct ones if they fit,
	// otherwise k-means over the distinct colours weighted by their counts
	if ( numColors <= 255 ) {
		numCent = numColors;
		for ( i = 0 ; i < numColors ; i++ ) {
			VectorCopy( colors[i].rgb, cent[i] );
		}
	} else {
		numCent = 255;
		for ( i = 0 ; i < numCent ; i++ ) {
			k = (int)( (double)i * numColors / numCent );
			VectorCopy( colors[k].rgb, cent[i] );
		}
		for ( it = 0 ; it < 12 ; it++ ) {
			memset( sum, 0, sizeof( sum ) );
			for ( i = 0 ; i < numColors ; i++ ) {
				float bd = 1e30f, d;
				best = 0;
				for ( k = 0 ; k < numCent ; k++ ) {
					d = ( colors[i].rgb[0] - cent[k][0] ) * ( colors[i].rgb[0] - cent[k][0] )
					  + ( colors[i].rgb[1] - cent[k][1] ) * ( colors[i].rgb[1] - cent[k][1] )
					  + ( colors[i].rgb[2] - cent[k][2] ) * ( colors[i].rgb[2] - cent[k][2] );
					if ( d < bd ) {
						bd = d;
						best = k;
					}
				}
				for ( k = 0 ; k < 3 ; k++ ) {
					sum[best][k] += (double)colors[i].rgb[k] * colors[i].count;
				}
				sum[best][3] += colors[i].count;
			}
			for ( k = 0 ; k < numCent ; k++ ) {
				if ( sum[k][3] > 0 ) {
					cent[k][0] = sum[k][0] / sum[k][3];
					cent[k][1] = sum[k][1] / sum[k][3];
					cent[k][2] = sum[k][2] / sum[k][3];
				}
			}
		}
	}
	memset( mohGridPalette, 0, sizeof( mohGridPalette ) );
	for ( k = 0 ; k < numCent ; k++ ) {
		for ( i = 0 ; i < 3 ; i++ ) {
			float c = cent[k][i] + 0.5f;
			mohGridPalette[( k + 1 ) * 3 + i] = c > 255 ? 255 : ( c < 0 ? 0 : (byte)c );
		}
	}
	// each distinct colour's palette index
	for ( i = 0 ; i < numColors ; i++ ) {
		float bd = 1e30f, d;
		best = 0;
		for ( k = 0 ; k < numCent ; k++ ) {
			d = ( colors[i].rgb[0] - cent[k][0] ) * ( colors[i].rgb[0] - cent[k][0] )
			  + ( colors[i].rgb[1] - cent[k][1] ) * ( colors[i].rgb[1] - cent[k][1] )
			  + ( colors[i].rgb[2] - cent[k][2] ) * ( colors[i].rgb[2] - cent[k][2] );
			if ( d < bd ) {
				bd = d;
				best = k;
			}
		}
		colors[i].count = best + 1;		// reused: the palette index
	}

	// the columns
	numMohGridOffsets = gridBounds[0] * gridBounds[1] + gridBounds[0];
	mohGridOffsets = malloc( numMohGridOffsets * sizeof( unsigned short ) );
	cap = total * 2 + 1024;
	mohGridData = malloc( cap );
	mohGridDataSize = 0;
	column = malloc( gridBounds[2] );
	for ( x = 0 ; x < gridBounds[0] ; x++ ) {
		int high = mohGridDataSize >> 8;

		if ( high > 0xffff ) {
			Error( "the light grid is too big for its offsets" );
		}
		mohGridOffsets[x] = high;
		for ( y = 0 ; y < gridBounds[1] ; y++ ) {
			int low = mohGridDataSize - ( high << 8 );

			if ( low > 0xffff ) {
				Error( "a slice of the light grid is too big for its offsets" );
			}
			mohGridOffsets[gridBounds[0] + y + gridBounds[1] * x] = low;
			for ( z = 0 ; z < gridBounds[2] ; z++ ) {
				num = x + y * gridBounds[0] + z * gridBounds[0] * gridBounds[1];
				column[z] = index[num] < 0 ? 0 : colors[index[num]].count;
			}
			// runs of two or more the same, literals between
			for ( z = 0 ; z < gridBounds[2] ; ) {
				for ( run = 1 ; z + run < gridBounds[2] && run < 129 && column[z + run] == column[z] ; run++ ) {
				}
				if ( run >= 2 ) {
					mohGridData[mohGridDataSize++] = (byte)( run - 2 );
					mohGridData[mohGridDataSize++] = column[z];
					z += run;
					continue;
				}
				for ( n = 1 ; z + n < gridBounds[2] && n < 128 ; n++ ) {
					if ( z + n + 1 < gridBounds[2] && column[z + n] == column[z + n + 1] ) {
						break;		// a run starts there
					}
				}
				mohGridData[mohGridDataSize++] = (byte)( -n );
				for ( k = 0 ; k < n ; k++ ) {
					mohGridData[mohGridDataSize++] = column[z + k];
				}
				z += n;
			}
			if ( mohGridDataSize > cap - 512 ) {
				cap *= 2;
				mohGridData = realloc( mohGridData, cap );
			}
		}
	}
	_printf( "%5i light grid colours, %i in the palette, %i bytes of grid\n", numColors, numCent, mohGridDataSize );

	free( column );
	free( index );
	free( colors );
	free( hashHead );
	free( hashNext );
}

/*
================
Terrain lightmaps

Each terrain patch gets a block of lmapScale * 8 + 1 texels each way (17 at the usual
2: a texel every 32 units), packed into lightmap pages added after the surfaces' own,
row by row, as the game's maps have them. Texel (i, j) lies at x0 + i * step,
y0 + j * step on the patch's surface (the renderer's s along x and t along y), lit as
any surface is; the terrain itself doesn't cast shadows here.
================
*/
static int	terrainPageBase;

static float PatchHeight( const cTerraPatch_t *p, float fi, float fj ) {
	int		i = (int)fi, j = (int)fj;
	float	fx, fy, h00, h10, h01, h11;

	if ( i > 7 ) i = 7;
	if ( j > 7 ) j = 7;
	fx = fi - i;
	fy = fj - j;
	h00 = p->heightmap[j * 9 + i];
	h10 = p->heightmap[j * 9 + i + 1];
	h01 = p->heightmap[( j + 1 ) * 9 + i];
	h11 = p->heightmap[( j + 1 ) * 9 + i + 1];
	return p->iBaseHeight + 2 * ( h00 * ( 1 - fx ) * ( 1 - fy ) + h10 * fx * ( 1 - fy ) + h01 * ( 1 - fx ) * fy + h11 * fx * fy );
}

static void LightTerrainPatch( int num ) {
	cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[num];
	int				size = p->lmapScale * 8 + 1, i, j;
	float			step = 64.0f / p->lmapScale;
	traceWork_t		tw;
	byte			*out;

	memset( &tw, 0, sizeof( tw ) );
	for ( j = 0 ; j < size ; j++ ) {
		for ( i = 0 ; i < size ; i++ ) {
			vec3_t	origin, normal, color;
			float	fi = i * step / 64.0f, fj = j * step / 64.0f, e = 0.25f;

			origin[0] = p->x * 64.0f + i * step;
			origin[1] = p->y * 64.0f + j * step;
			origin[2] = PatchHeight( p, fi, fj );
			normal[0] = ( PatchHeight( p, fi > e ? fi - e : 0, fj ) - PatchHeight( p, fi + e < 8 ? fi + e : 8, fj ) ) / ( ( ( fi + e < 8 ? fi + e : 8 ) - ( fi > e ? fi - e : 0 ) ) * 64.0f );
			normal[1] = ( PatchHeight( p, fi, fj > e ? fj - e : 0 ) - PatchHeight( p, fi, fj + e < 8 ? fj + e : 8 ) ) / ( ( ( fj + e < 8 ? fj + e : 8 ) - ( fj > e ? fj - e : 0 ) ) * 64.0f );
			normal[2] = 1;
			if ( p->flags & TERPATCH_FLIP ) {
				VectorScale( normal, -1, normal );
			}
			VectorNormalize( normal, normal );
			VectorMA( origin, 2, normal, origin );
			LightingAtSample( origin, normal, color, qtrue, qfalse, &tw );
			out = lightBytes + p->iLightMap * LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3
				+ ( ( p->t + j ) * LIGHTMAP_WIDTH + p->s + i ) * 3;
			LightmapToBytes( color, out );
		}
	}
}

void TerrainLightmaps( void ) {
	int		k, s = 0, t = 0, size, page;

	if ( !numTerraPatches ) {
		return;
	}
	terrainPageBase = numLightBytes / ( LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3 );
	page = terrainPageBase;
	for ( k = 0 ; k < numTerraPatches ; k++ ) {
		cTerraPatch_t *p = (cTerraPatch_t *)&terraPatches[k];

		if ( p->lmapScale <= 0 ) {
			p->lmapScale = 2;
		}
		size = p->lmapScale * 8 + 1;
		if ( s + size > LIGHTMAP_WIDTH ) {
			s = 0;
			t += size;
		}
		if ( t + size > LIGHTMAP_HEIGHT ) {
			page++;
			s = t = 0;
		}
		p->iLightMap = page;
		p->s = s;
		p->t = t;
		s += size;
	}
	numLightBytes = ( page + 1 ) * LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3;
	if ( numLightBytes > MAX_MAP_LIGHTING ) {
		Error( "MAX_MAP_LIGHTING: the terrain's lightmaps don't fit" );
	}
	memset( lightBytes + terrainPageBase * LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3, 0,
		numLightBytes - terrainPageBase * LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3 );
	RunThreadsOnIndividual( numTerraPatches, qtrue, LightTerrainPatch );
	_printf( "%5i terrain patches lit, %i lightmap pages\n", numTerraPatches, page - terrainPageBase + 1 );
}

/*
================
Sphere lights

The game lights models (players, weapons, props) from the map's lights, not from the
lightmaps: each light entity becomes a sphere light (origin, colour, "light" as its
intensity, the leaf it is in, a spotlight's aim and spread), and each leaf lists the ones
that can reach a model in it, the sun first (as -2) when the leaf sees the sky. A light
with NO_ENTITIES (spawnflags 2) lights the world only; ENTITY_TRACE (4) asks the game to
trace to the model before lighting it.

The game's renderer stops adding a light where intensity * 7500 / distance^2 falls under
5, so a leaf lists a light whose cluster it can see within that distance of the leaf's box
(as the game's maps do, without a line-of-sight test: a light that must not reach through
a wall is given ENTITY_TRACE).
================
*/
int PointInLeafnum( vec3_t point );

static qboolean MohClusterSees( int a, int b ) {
	int		rowBytes;

	if ( a < 0 || b < 0 ) {
		return qfalse;
	}
	if ( numVisBytes < 8 ) {
		return qtrue;		// no vis: everything sees everything
	}
	rowBytes = ( (int *)visBytes )[1];
	return ( visBytes[8 + a * rowBytes + ( b >> 3 )] >> ( b & 7 ) ) & 1;
}

// the leaf a light is in; one just inside a wall or a detail brush takes the open leaf
// beside it
static int MohLightLeaf( const vec3_t org ) {
	vec3_t	p;
	int		leaf, d, k, sign;

	VectorCopy( org, p );
	leaf = PointInLeafnum( p );
	for ( d = 1 ; d <= 16 && dleafs[leaf].cluster < 0 ; d *= 2 ) {
		for ( k = 0 ; k < 3 ; k++ ) {
			for ( sign = -1 ; sign <= 1 ; sign += 2 ) {
				VectorCopy( org, p );
				p[k] += sign * d;
				if ( dleafs[PointInLeafnum( p )].cluster >= 0 ) {
					return PointInLeafnum( p );
				}
			}
		}
	}
	return leaf;
}

void MohSphereLights( void ) {
	int			i, j, k, n, flags;
	entity_t	*e;
	dspherel_t	*sl;
	const char	*v;
	float		reach[MAX_MAP_SPHERELIGHTS];
	byte		*skyCluster;
	int			numClusters;
	qboolean	sun;

	numSphereLights = 0;
	for ( i = 1 ; i < num_entities ; i++ ) {
		e = &entities[i];
		if ( strncmp( ValueForKey( e, "classname" ), "light", 5 ) ) {
			continue;
		}
		flags = (int)FloatForKey( e, "spawnflags" );
		if ( flags & 2 ) {
			continue;
		}
		if ( numSphereLights == MAX_MAP_SPHERE_L_SIZE - 1 ) {
			_printf( "WARNING: more than %i lights for models: the rest light the world only\n", MAX_MAP_SPHERE_L_SIZE - 1 );
			break;
		}
		sl = &sphereLights[numSphereLights];
		memset( sl, 0, sizeof( *sl ) );
		GetVectorForKey( e, "origin", sl->origin );
		sl->intensity = FloatForKey( e, "light" );
		if ( !sl->intensity ) {
			sl->intensity = FloatForKey( e, "_light" );
		}
		if ( !sl->intensity ) {
			sl->intensity = 300;
		}
		v = ValueForKey( e, "_color" );
		if ( v[0] ) {
			sscanf( v, "%f %f %f", &sl->color[0], &sl->color[1], &sl->color[2] );
			ColorNormalize( sl->color, sl->color );
		} else {
			sl->color[0] = sl->color[1] = sl->color[2] = 1;
		}
		sl->leaf = MohLightLeaf( sl->origin );
		sl->needs_trace = ( flags & 4 ) != 0;
		if ( ValueForKey( e, "angles" )[0] || ValueForKey( e, "radius" )[0] ) {
			vec3_t	ang;
			double	p, y;
			float	radius;

			VectorClear( ang );
			if ( ValueForKey( e, "angles" )[0] ) {
				GetVectorForKey( e, "angles", ang );
			}
			p = ang[0] * Q_PI / 180.0;
			y = ang[1] * Q_PI / 180.0;
			sl->spot_dir[0] = cos( p ) * cos( y );
			sl->spot_dir[1] = cos( p ) * sin( y );
			sl->spot_dir[2] = -sin( p );
			radius = FloatForKey( e, "radius" );
			if ( !radius ) {
				radius = 64;
			}
			sl->spot_light = qtrue;
			sl->spot_radiusbydistance = ( radius + 16 ) / 64;
		}
		reach[numSphereLights] = sqrt( fabs( sl->intensity ) * 1500.0f );
		numSphereLights++;
	}

	// the clusters with a sky face in them, for the sun
	numClusters = numVisBytes >= 8 ? ( (int *)visBytes )[0] : 0;
	for ( i = 0 ; i < numleafs ; i++ ) {
		if ( dleafs[i].cluster >= numClusters ) {
			numClusters = dleafs[i].cluster + 1;
		}
	}
	skyCluster = calloc( numClusters + 1, 1 );
	for ( i = 0 ; i < numleafs ; i++ ) {
		if ( dleafs[i].cluster < 0 ) {
			continue;
		}
		for ( k = 0 ; k < dleafs[i].numLeafSurfaces ; k++ ) {
			n = dleafsurfaces[dleafs[i].firstLeafSurface + k];
			if ( dshaders[drawSurfaces[n].shaderNum].surfaceFlags & SURF_SKY ) {
				skyCluster[dleafs[i].cluster] = 1;
				break;
			}
		}
	}
	sun = ValueForKey( &entities[0], "suncolor" )[0] && VectorLength( sunLight ) > 0;

	numSphereLightVis = 0;
	n = 0;
	for ( i = 0 ; i < numleafs ; i++ ) {
		dleaf_t	*leaf = &dleafs[i];

		if ( numSphereLightVis + numSphereLights + 2 > MAX_MAP_SPHERELIGHTVIS ) {
			Error( "MAX_MAP_SPHERELIGHTVIS" );
		}
		if ( leaf->cluster >= 0 ) {
			if ( sun ) {
				for ( k = 0 ; k < numClusters ; k++ ) {
					if ( skyCluster[k] && MohClusterSees( leaf->cluster, k ) ) {
						sphereLightVis[numSphereLightVis++] = -2;
						break;
					}
				}
			}
			for ( j = 0 ; j < numSphereLights ; j++ ) {
				vec3_t	d;
				sl = &sphereLights[j];
				if ( !MohClusterSees( leaf->cluster, dleafs[sl->leaf].cluster ) ) {
					continue;
				}
				for ( k = 0 ; k < 3 ; k++ ) {
					d[k] = sl->origin[k] < leaf->mins[k] ? leaf->mins[k] - sl->origin[k]
						: ( sl->origin[k] > leaf->maxs[k] ? sl->origin[k] - leaf->maxs[k] : 0 );
				}
				if ( VectorLength( d ) > reach[j] ) {
					continue;
				}
				sphereLightVis[numSphereLightVis++] = j;
				n++;
			}
		}
		sphereLightVis[numSphereLightVis++] = -1;
	}
	free( skyCluster );
	_printf( "%5i lights for models, %i listings in %i leaves\n", numSphereLights, n, numleafs );
}

/*
================
Static model vertex light

The game draws a static model (a static_* prop) with a colour per vertex from the static
model data lump: 3 bytes a vertex, each model's run starting at its firstVertexData (a
byte offset) and numVertexData long, its vertices in the game's order (every surface of
every mesh). ommap doesn't read models, so the launcher writes them beside the .bsp as
<name>.smv ("SMV1", the model count, then per model its vertex count and each vertex's
world position and normal); each vertex is lit as the game lights a model, from the
model's centre (the mean of its vertices) and the vertex's facing, traced from 4 units off
the model along its normal (MohVertexLight). Without that file, or when a model is missing
from it, no vertex light is written and the game falls back to its own.
================
*/
void MohStaticModelLight( void ) {
	char		name[1024];
	FILE		*f;
	char		magic[4];
	int			count, i, j, n, total;
	int			*nv;
	float		*v;
	long		size;
	traceWork_t	*tw;

	numStaticModelVertColors = 0;
	for ( i = 0 ; i < numStaticModels ; i++ ) {
		staticModels[i].firstVertexData = 0;
		staticModels[i].numVertexData = 0;
	}
	if ( !numStaticModels ) {
		return;
	}
	strcpy( name, source );
	StripExtension( name );
	strcat( name, ".smv" );
	f = fopen( name, "rb" );
	if ( !f ) {
		_printf( "no %s: static models get no vertex light\n", name );
		return;
	}
	fseek( f, 0, SEEK_END );
	size = ftell( f );
	fseek( f, 0, SEEK_SET );
	if ( fread( magic, 1, 4, f ) != 4 || memcmp( magic, "SMV1", 4 ) || fread( &count, 4, 1, f ) != 1
		|| count != numStaticModels ) {
		fclose( f );
		_printf( "WARNING: %s doesn't fit this map's static models: no vertex light\n", name );
		return;
	}
	nv = malloc( count * sizeof( *nv ) );
	v = malloc( size );
	total = 0;
	for ( i = 0 ; i < count ; i++ ) {
		if ( fread( &nv[i], 4, 1, f ) != 1 || nv[i] < 0 || nv[i] > 32767
			|| (long)( total + nv[i] ) * 24 > size ) {
			break;
		}
		if ( nv[i] && fread( v + total * 6, 24, nv[i], f ) != (size_t)nv[i] ) {
			break;
		}
		if ( !nv[i] ) {
			break;			// a model without its vertices: none get light (see above)
		}
		total += nv[i];
	}
	fclose( f );
	if ( i < count || total * 3 > MAX_MAP_STATICMODELVERTCOLORS ) {
		_printf( "WARNING: %s lacks a model's vertices (or has too many): no vertex light\n", name );
		free( nv );
		free( v );
		return;
	}

	tw = malloc( sizeof( *tw ) );
	tw->patchshadows = qtrue;		// curved patches shade the props, as for the grid
	n = 0;
	for ( i = 0 ; i < count ; i++ ) {
		vec3_t	centre, base;

		staticModels[i].firstVertexData = n * 3;
		staticModels[i].numVertexData = nv[i];
		VectorClear( centre );
		for ( j = 0 ; j < nv[i] ; j++ ) {
			float	*q = v + ( n + j ) * 6;
			VectorAdd( centre, q, centre );
		}
		VectorScale( centre, 1.0f / nv[i], centre );
		MohStaticModelBase( centre, base );
		for ( j = 0 ; j < nv[i] ; j++, n++ ) {
			vec3_t	origin, normal, color;
			float	*p = v + n * 6;

			normal[0] = p[3];
			normal[1] = p[4];
			normal[2] = p[5];
			if ( VectorNormalize( normal, normal ) == 0 ) {
				normal[2] = 1;
			}
			VectorMA( p, 4, normal, origin );
			MohVertexLight( origin, p, normal, centre, base, color, tw );
			ColorToBytes( color, staticModelVertColors + n * 3 );
		}
	}
	numStaticModelVertColors = n;
	free( tw );
	free( nv );
	free( v );
	_printf( "%5i static model vertices lit\n", n );
}
