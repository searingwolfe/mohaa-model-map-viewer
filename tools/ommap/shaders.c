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

#include <string.h>
#include <math.h>
#include "cmdlib.h"
#include "mathlib.h"
#include "imagelib.h"
#include "scriplib.h"

// su44: use qfiles.h from OpenMoHAA codebase
#include "mohaa_qfiles.h"
#include "mohaa_surfaceflags.h"

#include "shaders.h"
#if defined(_WIN32) && defined(OMMAP_PAK)	// the editor's pak and JPEG readers, left out

#ifdef _TTIMOBUILD
#include "pakstuff.h"
#include "jpeglib.h"
#else
#include "libs/pakstuff.h"
#include "../libs/jpeglib.h"
#endif

#endif


// 5% backsplash by default
#define	DEFAULT_BACKSPLASH_FRACTION		0.05
#define	DEFAULT_BACKSPLASH_DISTANCE		24


#define	MAX_SURFACE_INFO	4096

shaderInfo_t	defaultInfo;
shaderInfo_t	shaderInfo[MAX_SURFACE_INFO];
int				numShaderInfo;


typedef struct {
	char	*name;
	int		clearSolid, surfaceFlags, contents;
} infoParm_t;

// MoHAA's surfaceparms, as the game's renderer reads them (renderergl1/tr_shader.c
// infoParms) with the flag values of the game's surfaceflags.h, plus the compile-only
// ones q3map adds (areaportal, structural, the bot clips).
infoParm_t	infoParms[] = {
	// server relevant contents
	{"water",		1,	0,	CONTENTS_WATER },
	{"slime",		1,	0,	CONTENTS_SLIME },		// mildly damaging
	{"lava",		1,	0,	CONTENTS_LAVA },		// very damaging
	{"playerclip",	1,	0,	CONTENTS_PLAYERCLIP },
	{"monsterclip",	1,	0,	CONTENTS_MONSTERCLIP },
	{"fence",		1,	0,	CONTENTS_FENCE },
	{"weaponclip",	1,	0,	CONTENTS_WEAPONCLIP },
	{"vehicleclip",	1,	0,	CONTENTS_VEHICLECLIP },
	{"nodrop",		1,	0,	CONTENTS_NODROP },		// don't drop items or leave bodies (death fog, lava, etc)
	{"nonsolid",	1,	SURF_NONSOLID,	0 },		// clears the solid flag

	// utility relevant attributes
	{"origin",		1,	0,	CONTENTS_ORIGIN },		// center of rotating brushes
	{"trans",		0,	0,	CONTENTS_TRANSLUCENT },	// don't eat contained surfaces
	{"detail",		0,	0,	CONTENTS_DETAIL },		// don't include in structural bsp
	{"structural",	0,	0,	CONTENTS_STRUCTURAL },	// force into structural bsp even if trans
	{"areaportal",	1,	0,	CONTENTS_AREAPORTAL },	// divides areas
	{"donotenter",  1,  0,  CONTENTS_DONOTENTER },	// for bots
	{"botclip",     1,  0,  CONTENTS_BOTCLIP },		// for bots
	{"nobotclip",	0,	0,	CONTENTS_NOBOTCLIP },	// don't use for bot clipping
	{"fog",			1,	0,	CONTENTS_FOG},			// carves surfaces entering
	{"sky",			0,	SURF_SKY,			0 },	// emit light from an environment map
	{"alphashadow",	0,	SURF_ALPHASHADOW,	0 },	// test light on a per-pixel basis
	{"hint",		0,	SURF_HINT,		0 },		// use as a primary splitter

	// server attributes
	{"slick",		0,	SURF_SLICK,		0 },
	{"noimpact",	0,	SURF_NOIMPACT,	0 },		// don't make impact explosions or marks
	{"nomarks",		0,	SURF_NOMARKS,	0 },		// don't make impact marks, but still explode
	{"ladder",		0,	SURF_LADDER,	0 },
	{"nodamage",	0,	SURF_NODAMAGE,	0 },
	{"nosteps",		0,	SURF_NOSTEPS,	0 },
	{"paper",		0,	SURF_PAPER,		0 },
	{"wood",		0,	SURF_WOOD,		0 },
	{"metal",		0,	SURF_METAL,		0 },
	{"rock",		0,	SURF_ROCK,		0 },
	{"dirt",		0,	SURF_DIRT,		0 },
	{"grill",		0,	SURF_GRILL,		0 },
	{"grass",		0,	SURF_GRASS,		0 },
	{"mud",			0,	SURF_MUD,		0 },
	{"puddle",		0,	SURF_PUDDLE,	0 },
	{"glass",		0,	SURF_GLASS,		0 },
	{"gravel",		0,	SURF_GRAVEL,	0 },
	{"sand",		0,	SURF_SAND,		0 },
	{"foliage",		0,	SURF_FOLIAGE,	0 },
	{"snow",		0,	SURF_SNOW,		0 },
	{"carpet",		0,	SURF_CARPET,	0 },

	// drawsurf attributes
	{"nodraw",		0,	SURF_NODRAW,		0 },	// don't generate a drawsurface (or a lightmap)
	{"castshadow",	0,	SURF_CASTSHADOW,	0 },
	{"nolightmap",	0,	SURF_NOLIGHTMAP,	0 },	// don't generate a lightmap
	{"nodlight",	0,	SURF_NODLIGHT,		0 },	// don't ever add dynamic lights
};


/*
===============
LoadShaderImage
===============
*/

static int	imageFileLength;		// the length of the file LoadImageFile last read

/*
===============
JpegSize

A .jpg's width and height, from its frame header; qfalse if it has none.
===============
*/
static qboolean JpegSize( const byte *b, int len, int *width, int *height ) {
	int		i = 2;

	if ( len < 4 || b[0] != 0xFF || b[1] != 0xD8 ) {
		return qfalse;
	}
	while ( i + 9 < len ) {
		int	marker, seg;
		if ( b[i] != 0xFF ) {
			return qfalse;
		}
		marker = b[i + 1];
		if ( marker == 0xFF ) {
			i++;
			continue;
		}
		if ( marker == 0xD8 || ( marker >= 0xD0 && marker <= 0xD7 ) || marker == 0x01 ) {
			i += 2;
			continue;
		}
		seg = ( b[i + 2] << 8 ) | b[i + 3];
		if ( seg < 2 ) {
			return qfalse;
		}
		if ( marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC ) {
			*height = ( b[i + 5] << 8 ) | b[i + 6];
			*width = ( b[i + 7] << 8 ) | b[i + 8];
			return *width > 0 && *height > 0;
		}
		i += 2 + seg;
	}
	return qfalse;
}

byte* LoadImageFile(char *filename, qboolean *bTGA)
{
  byte *buffer = NULL;
  int nLen = 0;
  *bTGA = qtrue;
  imageFileLength = 0;
  if (FileExists(filename))
  {
    imageFileLength = LoadFileBlock(filename, &buffer);
  }
#if defined(_WIN32) && defined(OMMAP_PAK)
  else
  {
    PakLoadAnyFile(filename, &buffer);
  }
#endif
  if ( buffer == NULL)
  {
    nLen = strlen(filename);
    filename[nLen-3] = 'j';
    filename[nLen-2] = 'p';
    filename[nLen-1] = 'g';
    if (FileExists(filename))
    {
      imageFileLength = LoadFileBlock(filename, &buffer);
    }
#if defined(_WIN32) && defined(OMMAP_PAK)
    else
    {
      PakLoadAnyFile(filename, &buffer);
    }
#endif
    if ( buffer )
    {
      *bTGA = qfalse;
    }
  }
  return buffer;
}

/*
===============
LoadShaderImage
===============
*/
static void LoadShaderImage( shaderInfo_t *si ) {
	char			filename[1024];
	int				i, count;
	float			color[4];
  byte      *buffer;
  qboolean  bTGA = qtrue;

	// look for the lightimage if it is specified
	if ( si->lightimage[0] ) {
		sprintf( filename, "%s%s", gamedir, si->lightimage );
		DefaultExtension( filename, ".tga" );
    buffer = LoadImageFile(filename, &bTGA);
    if ( buffer != NULL) {
      goto loadTga;
    }
  }

	// look for the editorimage if it is specified
	if ( si->editorimage[0] ) {
		sprintf( filename, "%s%s", gamedir, si->editorimage );
		DefaultExtension( filename, ".tga" );
    buffer = LoadImageFile(filename, &bTGA);
    if ( buffer != NULL) {
      goto loadTga;
    }
  }

  // just try the shader name with a .tga
	// on unix, we have case sensitivity problems...
  sprintf( filename, "%s%s.tga", gamedir, si->shader );
  buffer = LoadImageFile(filename, &bTGA);
  if ( buffer != NULL) {
		goto loadTga;
	}

  sprintf( filename, "%s%s.TGA", gamedir, si->shader );
  buffer = LoadImageFile(filename, &bTGA);
  if ( buffer != NULL) {
		goto loadTga;
	}

	// couldn't load anything
	_printf("WARNING: Couldn't find image for shader %s\n", si->shader );

	si->color[0] = 1;
	si->color[1] = 1;
	si->color[2] = 1;
	si->width = 64;
	si->height = 64;
	si->pixels = malloc( si->width * si->height * 4 );
	memset ( si->pixels, 255, si->width * si->height * 4 );
	return;

	// load the image to get dimensions and color
loadTga:
  if ( bTGA) {
	  LoadTGABuffer( buffer, &si->pixels, &si->width, &si->height );
  }
  else {
#if defined(_WIN32) && defined(OMMAP_PAK)
    LoadJPGBuff(buffer, &si->pixels, &si->width, &si->height );
#else
    // without a JPEG decoder: its size (which lays the texture out) and plain white
    // pixels, as for an image not found (a .jpg has no alpha, so it is solid to light)
    if ( !JpegSize( buffer, imageFileLength, &si->width, &si->height ) ) {
      si->width = si->height = 64;
    }
    si->pixels = malloc( si->width * si->height * 4 );
    memset( si->pixels, 255, si->width * si->height * 4 );
#endif
  }

  free(buffer);

	count = si->width * si->height;

	VectorClear( color );
	color[ 3 ] = 0;
	for ( i = 0 ; i < count ; i++ ) {
		color[0] += si->pixels[ i * 4 + 0 ];
		color[1] += si->pixels[ i * 4 + 1 ];
		color[2] += si->pixels[ i * 4 + 2 ];
		color[3] += si->pixels[ i * 4 + 3 ];
	}
	ColorNormalize( color, si->color );
	VectorScale( color, 1.0/count, si->averageColor );
}

/*
===============
AllocShaderInfo
===============
*/
static shaderInfo_t	*AllocShaderInfo( void ) {
	shaderInfo_t	*si;

	if ( numShaderInfo == MAX_SURFACE_INFO ) {
		Error( "MAX_SURFACE_INFO" );
	}
	si = &shaderInfo[ numShaderInfo ];
	numShaderInfo++;

	// set defaults

	si->contents = CONTENTS_SOLID;

	si->backsplashFraction = DEFAULT_BACKSPLASH_FRACTION;
	si->backsplashDistance = DEFAULT_BACKSPLASH_DISTANCE;

	si->lightmapSampleSize = 0;
	si->forceTraceLight = qfalse;
	si->forceVLight = qfalse;
	si->patchShadows = qfalse;
	si->vertexShadows = qfalse;
	si->noVertexShadows = qfalse;
	si->forceSunLight = qfalse;
	si->vertexScale = 1.0;
	si->notjunc = qfalse;

	return si;
}

/*
===============
ShaderInfoForShader
===============
*/
shaderInfo_t	*ShaderInfoForShader( const char *shaderName ) {
	int				i;
	shaderInfo_t	*si;
	char			shader[MAX_QPATH];

	// strip off extension
	strcpy( shader, shaderName );
	StripExtension( shader );

	// search for it
	for ( i = 0 ; i < numShaderInfo ; i++ ) {
		si = &shaderInfo[ i ];
		if ( !Q_stricmp( shader, si->shader ) ) {
			if ( !si->width ) {
				LoadShaderImage( si );
			}
			return si;
		}
	}

	si = AllocShaderInfo();
	strcpy( si->shader, shader );

	LoadShaderImage( si );

	return si;
}

/*
===============
ParseShaderFile
===============
*/
static void ParseShaderFile( const char *filename ) {
	int		i;
	int		numInfoParms = sizeof(infoParms) / sizeof(infoParms[0]);
	shaderInfo_t	*si;

//	qprintf( "shaderFile: %s\n", filename );
	LoadScriptFile( filename );
	while ( 1 ) {
		if ( !GetToken( qtrue ) ) {
			break;
		}

		si = AllocShaderInfo();
		strcpy( si->shader, token );
		MatchToken( "{" );
		while ( 1 ) {
			if ( !GetToken( qtrue ) ) {
				break;
			}
			if ( !strcmp( token, "}" ) ) {
				break;
			}

			// skip internal braced sections
			if ( !strcmp( token, "{" ) ) {
				si->hasPasses = qtrue;
				while ( 1 ) {
					if ( !GetToken( qtrue ) ) {
						break;
					}
					if ( !strcmp( token, "}" ) ) {
						break;
					}
				}
				continue;
			}

			if ( !Q_stricmp( token, "surfaceparm" ) ) {
				GetToken( qfalse );
				for ( i = 0 ; i < numInfoParms ; i++ ) {
					if ( !Q_stricmp( token, infoParms[i].name ) ) {
						si->surfaceFlags |= infoParms[i].surfaceFlags;
						si->contents |= infoParms[i].contents;
						if ( infoParms[i].clearSolid ) {
							si->contents &= ~CONTENTS_SOLID;
						}
						break;
					}
				}
				if ( i == numInfoParms ) {
					// we will silently ignore all tokens beginning with qer,
					// which are QuakeEdRadient parameters
					if ( Q_strncasecmp( token, "qer", 3 ) ) {
						_printf( "Unknown surfaceparm: \"%s\"\n", token );
					}
				}
				continue;
			}


			// qer_editorimage <image>
			if ( !Q_stricmp( token, "qer_editorimage" ) ) {
				GetToken( qfalse );
				strcpy( si->editorimage, token );
				DefaultExtension( si->editorimage, ".tga" );
				continue;
			}

			// q3map_lightimage <image>
			if ( !Q_stricmp( token, "q3map_lightimage" ) ) {
				GetToken( qfalse );
				strcpy( si->lightimage, token );
				DefaultExtension( si->lightimage, ".tga" );
				continue;
			}

			// q3map_surfacelight <value>
			if ( !Q_stricmp( token, "q3map_surfacelight" )  ) {
				GetToken( qfalse );
				si->value = atoi( token );
				continue;
			}

			// q3map_lightsubdivide <value>
			if ( !Q_stricmp( token, "q3map_lightsubdivide" )  ) {
				GetToken( qfalse );
				si->lightSubdivide = atoi( token );
				continue;
			}

			// q3map_lightmapsamplesize <value>
			if ( !Q_stricmp( token, "q3map_lightmapsamplesize" ) ) {
				GetToken( qfalse );
				si->lightmapSampleSize = atoi( token );
				continue;
			}

			// q3map_tracelight
			if ( !Q_stricmp( token, "q3map_tracelight" ) ) {
				si->forceTraceLight = qtrue;
				continue;
			}

			// q3map_vlight
			if ( !Q_stricmp( token, "q3map_vlight" ) ) {
				si->forceVLight = qtrue;
				continue;
			}

			// q3map_patchshadows
			if ( !Q_stricmp( token, "q3map_patchshadows" ) ) {
				si->patchShadows = qtrue;
				continue;
			}

			// q3map_vertexshadows
			if ( !Q_stricmp( token, "q3map_vertexshadows" ) ) {
				si->vertexShadows = qtrue;
				continue;
			}

			// q3map_novertexshadows
			if ( !Q_stricmp( token, "q3map_novertexshadows" ) ) {
				si->noVertexShadows = qtrue;
				continue;
			}

			// q3map_forcesunlight
			if ( !Q_stricmp( token, "q3map_forcesunlight" ) ) {
				si->forceSunLight = qtrue;
				continue;
			}

			// q3map_vertexscale
			if ( !Q_stricmp( token, "q3map_vertexscale" ) ) {
				GetToken( qfalse );
				si->vertexScale = atof(token);
				continue;
			}

			// q3map_notjunc
			if ( !Q_stricmp( token, "q3map_notjunc" ) ) {
				si->notjunc = qtrue;
				continue;
			}

			// q3map_globaltexture
			if ( !Q_stricmp( token, "q3map_globaltexture" )  ) {
				si->globalTexture = qtrue;
				continue;
			}

			// q3map_backsplash <percent> <distance>
			if ( !Q_stricmp( token, "q3map_backsplash" ) ) {
				GetToken( qfalse );
				si->backsplashFraction = atof( token ) * 0.01;
				GetToken( qfalse );
				si->backsplashDistance = atof( token );
				continue;
			}

			// q3map_backshader <shader>
			if ( !Q_stricmp( token, "q3map_backshader" ) ) {
				GetToken( qfalse );
				strcpy( si->backShader, token );
				continue;
			}

			// q3map_flare <shader>
			if ( !Q_stricmp( token, "q3map_flare" ) ) {
				GetToken( qfalse );
				strcpy( si->flareShader, token );
				continue;
			}

			// light <value> 
			// old style flare specification
			if ( !Q_stricmp( token, "light" ) ) {
				GetToken( qfalse );
				strcpy( si->flareShader, "flareshader" );
				continue;
			}

			// q3map_sun <red> <green> <blue> <intensity> <degrees> <elivation>
			// color will be normalized, so it doesn't matter what range you use
			// intensity falls off with angle but not distance 100 is a fairly bright sun
			// degree of 0 = from the east, 90 = north, etc.  altitude of 0 = sunrise/set, 90 = noon
			if ( !Q_stricmp( token, "q3map_sun" ) ) {
				float	a, b;

				GetToken( qfalse );
				si->sunLight[0] = atof( token );
				GetToken( qfalse );
				si->sunLight[1] = atof( token );
				GetToken( qfalse );
				si->sunLight[2] = atof( token );
				
				VectorNormalize( si->sunLight, si->sunLight);

				GetToken( qfalse );
				a = atof( token );
				VectorScale( si->sunLight, a, si->sunLight);

				GetToken( qfalse );
				a = atof( token );
				a = a / 180 * Q_PI;

				GetToken( qfalse );
				b = atof( token );
				b = b / 180 * Q_PI;

				si->sunDirection[0] = cos( a ) * cos( b );
				si->sunDirection[1] = sin( a ) * cos( b );
				si->sunDirection[2] = sin( b );

				si->surfaceFlags |= SURF_SKY;
				continue;
			}

			// tesssize is used to force liquid surfaces to subdivide
			if ( !Q_stricmp( token, "tesssize" ) ) {
				GetToken( qfalse );
				si->subdivisions = atof( token );
				continue;
			}

			// cull none will set twoSided
			if ( !Q_stricmp( token, "cull" ) ) {
				GetToken( qfalse );
				if ( !Q_stricmp( token, "none" ) ) {
					si->twoSided = qtrue;
				}
				continue;
			}


			// deformVertexes autosprite[2]
			// we catch this so autosprited surfaces become point
			// lights instead of area lights
			if ( !Q_stricmp( token, "deformVertexes" ) ) {
				GetToken( qfalse );
				if ( !Q_strncasecmp( token, "autosprite", 10 ) ) {
					si->autosprite = qtrue;
          si->contents = CONTENTS_DETAIL;
				}
				continue;
			}


			// ignore all other tokens on the line

			while ( TokenAvailable() ) {
				GetToken( qfalse );
			}
		}			
	}
}

/*
===============
LoadShaderInfo
===============
*/
#define	MAX_SHADER_FILES	512
#ifdef _WIN32
#include <io.h>
#else
#include <dirent.h>
#endif
void LoadShaderInfo( void ) {
	char			filename[1024];
	int				i;
	char			*shaderFiles[MAX_SHADER_FILES];
	int				numShaderFiles;
	FILE *f;

	sprintf( filename, "%sscripts/shaderlist.txt", gamedir );

	numShaderFiles = 0;
	f = fopen(filename,"rb");
	if(f == 0) {
		// no shaderlist.txt in the scripts folder: every .shader file in it
		char scriptsDir[1024];
#ifdef _WIN32
		struct _finddata_t fileinfo;
		intptr_t handle;
		sprintf( scriptsDir, "%sscripts/*.shader", gamedir );
		handle = _findfirst (scriptsDir, &fileinfo);
		if (handle != -1)
		{
			do
			{
				if ( numShaderFiles >= MAX_SHADER_FILES ) {
					Error( "too many shader files (%i)", MAX_SHADER_FILES );
				}
				shaderFiles[numShaderFiles] = malloc(MAX_OS_PATH);
				strcpy( shaderFiles[ numShaderFiles ], fileinfo.name );
				StripExtension( shaderFiles[ numShaderFiles ] );
				numShaderFiles++;
			} while (_findnext( handle, &fileinfo ) != -1);
			_findclose (handle);
		}
#else
		DIR *dir;
		struct dirent *de;
		sprintf( scriptsDir, "%sscripts", gamedir );
		dir = opendir( scriptsDir );
		if ( dir ) {
			while ( ( de = readdir( dir ) ) != NULL ) {
				size_t n = strlen( de->d_name );
				if ( n < 8 || Q_stricmp( de->d_name + n - 7, ".shader" ) ) {
					continue;
				}
				if ( numShaderFiles >= MAX_SHADER_FILES ) {
					Error( "too many shader files (%i)", MAX_SHADER_FILES );
				}
				shaderFiles[numShaderFiles] = malloc(MAX_OS_PATH);
				strcpy( shaderFiles[ numShaderFiles ], de->d_name );
				StripExtension( shaderFiles[ numShaderFiles ] );
				numShaderFiles++;
			}
			closedir( dir );
		}
#endif
	} else {
		fclose(f);

		LoadScriptFile( filename );

		while ( 1 ) {
			if ( !GetToken( qtrue ) ) {
				break;
			}
			shaderFiles[numShaderFiles] = malloc(MAX_OS_PATH);
			strcpy( shaderFiles[ numShaderFiles ], token );
			numShaderFiles++;
		}
	}

	for ( i = 0 ; i < numShaderFiles ; i++ ) {
		sprintf( filename, "%sscripts/%s.shader", gamedir, shaderFiles[i] );
		if ( !FileExists( filename ) ) {
			_printf( "WARNING: %s is in shaderlist.txt but not in the scripts folder\n", filename );
			free( shaderFiles[i] );
			continue;
		}
		ParseShaderFile( filename );
    free(shaderFiles[i]);
	}

	qprintf( "%5i shaderInfo\n", numShaderInfo);
}

